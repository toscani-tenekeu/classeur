import { randomUUID } from 'node:crypto'
import {
  chmod, lchown, lstat, lutimes, mkdir, open, readdir, readlink, rename, rm, stat, symlink, utimes,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { config } from './config.ts'
import { db, logActivity } from './db.ts'
import { explain, FsError, mustRemove, mustWrite, path } from './fsops.ts'
import { type Handle, startJob } from './jobs.ts'
import { containsMount, mountPoints } from './paths.ts'
import { lines, reason, run } from './sys.ts'

export type Conflict = 'rename' | 'overwrite' | 'skip'

const within = (child: string, parent: string) => child === parent || child.startsWith(`${parent}/`)
const exists = (target: string) => lstat(target).then(() => true, () => false)

/** "report.pdf" → "report (2).pdf", the first name that is free. */
export async function freeName(dir: string, name: string): Promise<string> {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  for (let count = 2; count < 10_000; count += 1) {
    const candidate = join(dir, `${stem} (${count})${extension}`)
    if (!(await exists(candidate))) return candidate
  }
  throw new FsError('No free name was found.')
}

/** Bytes used by a file or a whole folder. */
export async function sizeOf(target: string): Promise<number> {
  const info = await lstat(target).catch(() => null)
  if (!info) return 0
  if (!info.isDirectory()) return info.size
  const result = await run(['du', '-skx', '--', target], { timeout: 60_000 })
  return (Number(lines(result.stdout).at(-1)?.split(/\s+/)[0]) || 0) * 1024
}

// ---- Copy ---------------------------------------------------------------------------

async function countBytes(target: string, handle: Handle): Promise<number> {
  handle.check()
  const info = await lstat(target)
  if (!info.isDirectory()) return info.isFile() ? info.size : 0
  let total = 0
  for (const name of await readdir(target)) total += await countBytes(join(target, name), handle)
  return total
}

async function copyFile(source: string, target: string, handle: Handle) {
  handle.job.now = source
  const input = await open(source, 'r')
  const output = await open(target, 'wx')
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024)
  try {
    for (;;) {
      handle.check()
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      await output.write(buffer, 0, bytesRead)
      handle.job.done += bytesRead
    }
  } finally {
    await input.close()
    await output.close()
  }
}

/** Copies a tree, keeping permissions, owners, times and links as they are. */
async function copyTree(source: string, target: string, handle: Handle) {
  handle.check()
  const info = await lstat(source)
  if (info.isSymbolicLink()) {
    await symlink(await readlink(source), target)
    await lchown(target, info.uid, info.gid).catch(() => undefined)
    await lutimes(target, info.atime, info.mtime).catch(() => undefined)
    return
  }
  if (info.isDirectory()) {
    await mkdir(target, { mode: 0o700 })
    for (const name of await readdir(source)) {
      try {
        await copyTree(join(source, name), join(target, name), handle)
      } catch (error) {
        if (handle.cancelled) throw error
        handle.job.errors.push(`${join(source, name)}: ${explain(error)}`)
      }
    }
  } else if (info.isFile()) {
    await copyFile(source, target, handle)
  } else {
    handle.job.errors.push(`${source}: special files such as sockets and devices are not copied.`)
    return
  }
  await lchown(target, info.uid, info.gid).catch(() => undefined)
  await chmod(target, info.mode & 0o7777)
  await utimes(target, info.atime, info.mtime).catch(() => undefined)
}

// ---- Trash --------------------------------------------------------------------------

/**
 * Items go to a trash folder on their own disk, so moving them there is
 * instant and needs no free space.
 */
function trashRoot(target: string, device: number, dataDevice: number): string {
  if (device === dataDevice) return join(config.dataDir, 'trash')
  const mount = mountPoints()
    .filter((point) => within(target, point))
    .sort((a, b) => b.length - a.length)[0] ?? '/'
  return join(mount, '.classeur-trash')
}

export async function trashItems(inputs: unknown[]) {
  const dataDevice = (await stat(config.dataDir)).dev
  const moved: string[] = []
  const failed: { path: string; message: string }[] = []

  for (const input of inputs.slice(0, 5000)) {
    let target = ''
    try {
      target = path(input)
      mustRemove(target)
      if (containsMount(target)) throw new FsError('A disk is mounted inside this folder. Unmount it first.')
      const info = await lstat(target)
      const id = randomUUID()
      const folder = trashRoot(target, info.dev, dataDevice)
      await mkdir(folder, { recursive: true, mode: 0o700 })
      const stored = join(folder, id)
      const size = await sizeOf(target)
      await rename(target, stored)
      db.query(
        'INSERT INTO trash (id, original, stored, name, directory, size, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(id, target, stored, basename(target), info.isDirectory() ? 1 : 0, size, Date.now())
      moved.push(target)
    } catch (error) {
      failed.push({ path: target || String(input), message: explain(error) })
    }
  }

  if (moved.length) {
    logActivity({
      area: 'trash',
      action: moved.length === 1 ? 'Moved to trash' : `Moved ${moved.length} items to trash`,
      target: moved.length === 1 ? moved[0] : dirname(moved[0]!),
      detail: moved.length === 1 ? '' : moved.join('\n'),
    })
  }
  return { ok: failed.length === 0, moved: moved.length, failed: failed.slice(0, 50) }
}

interface TrashRow {
  id: string
  original: string
  stored: string
  name: string
  directory: number
  size: number
  deleted_at: number
}

export function trashList() {
  const rows = db.query<TrashRow, []>('SELECT * FROM trash ORDER BY deleted_at DESC').all()
  return rows.map((row) => ({
    id: row.id,
    original: row.original,
    name: row.name,
    directory: row.directory === 1,
    size: row.size,
    deletedAt: row.deleted_at,
  }))
}

export async function restoreItems(ids: string[]) {
  const restored: string[] = []
  const failed: { path: string; message: string }[] = []
  for (const id of ids) {
    const row = db.query<TrashRow, [string]>('SELECT * FROM trash WHERE id = ?').get(id)
    if (!row) continue
    try {
      if (!(await exists(row.stored))) {
        db.query('DELETE FROM trash WHERE id = ?').run(id)
        throw new FsError('It is no longer in the trash.')
      }
      await mkdir(dirname(row.original), { recursive: true })
      const target = (await exists(row.original)) ? await freeName(dirname(row.original), row.name) : row.original
      await rename(row.stored, target)
      db.query('DELETE FROM trash WHERE id = ?').run(id)
      restored.push(target)
    } catch (error) {
      failed.push({ path: row.original, message: explain(error) })
    }
  }
  if (restored.length) {
    logActivity({ area: 'trash', action: restored.length === 1 ? 'Restored' : `Restored ${restored.length} items`, target: restored.join('\n') })
  }
  return { ok: failed.length === 0, restored, failed }
}

export async function purgeTrash(ids: string[] | 'all' | 'expired') {
  const rows =
    ids === 'all'
      ? db.query<TrashRow, []>('SELECT * FROM trash').all()
      : ids === 'expired'
        ? db.query<TrashRow, [number]>('SELECT * FROM trash WHERE deleted_at < ?').all(Date.now() - config.keepTrashDays * 86_400_000)
        : ids.map((id) => db.query<TrashRow, [string]>('SELECT * FROM trash WHERE id = ?').get(id)).filter((row): row is TrashRow => Boolean(row))
  let freed = 0
  let removed = 0
  for (const row of rows) {
    try {
      await rm(row.stored, { recursive: true, force: true })
      db.query('DELETE FROM trash WHERE id = ?').run(row.id)
      freed += row.size
      removed += 1
    } catch {
      // Left for the next attempt.
    }
  }
  if (removed && ids !== 'expired') {
    logActivity({ area: 'trash', action: ids === 'all' ? 'Emptied the trash' : `Deleted ${removed} items for good`, freed })
  }
  if (removed && ids === 'expired') logActivity({ area: 'trash', action: `Removed ${removed} items older than ${config.keepTrashDays} days`, freed })
  return { ok: true, removed, freed }
}

export function startTrashPurge() {
  setInterval(() => void purgeTrash('expired'), 3_600_000)
  setTimeout(() => void purgeTrash('expired'), 60_000)
}

// ---- Jobs: copy, move, delete ---------------------------------------------------------

interface TransferInput {
  op: 'copy' | 'move'
  sources: unknown[]
  destination: unknown
  conflict: Conflict
}

export async function startTransfer(input: TransferInput) {
  const destination = path(input.destination)
  const info = await stat(destination).catch(() => null)
  if (!info?.isDirectory()) throw new FsError('The destination is not a folder.')
  mustWrite(destination)

  const sources = input.sources.slice(0, 5000).map(path)
  if (!sources.length) throw new FsError('Nothing selected.')
  for (const source of sources) {
    if (input.op === 'move') mustRemove(source)
    if (within(destination, source)) throw new FsError(`A folder cannot be put inside itself: ${basename(source)}.`)
  }
  const verb = input.op === 'copy' ? 'Copying' : 'Moving'
  const title =
    sources.length === 1 ? `${verb} ${basename(sources[0]!)} to ${destination}` : `${verb} ${sources.length} items to ${destination}`

  return startJob(
    { kind: input.op, title, unit: 'bytes', folders: [destination, ...new Set(sources.map((source) => dirname(source)))] },
    async (handle) => {
      // Work out the size first, so the progress bar means something.
      handle.job.now = 'Measuring what to copy'
      for (const source of sources) {
        handle.job.total += await countBytes(source, handle).catch((error: unknown) => {
          if (handle.cancelled) throw error
          return 0
        })
      }

      let done = 0
      for (const source of sources) {
        handle.check()
        let target = join(destination, basename(source))
        try {
          if (target === source) {
            if (input.op === 'move') continue
            target = await freeName(destination, basename(source))
          } else if (await exists(target)) {
            if (input.conflict === 'skip') continue
            if (input.conflict === 'rename') target = await freeName(destination, basename(source))
            else {
              mustRemove(target)
              // A replaced item goes to the trash, never straight to oblivion.
              const outcome = await trashItems([target])
              if (!outcome.ok) throw new FsError(outcome.failed[0]?.message ?? 'The existing item could not be replaced.')
            }
          }

          if (input.op === 'move') {
            try {
              await rename(source, target)
              handle.job.done += await countBytes(target, handle).catch(() => 0)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
              // Another disk: copy, then remove the original once the copy is complete.
              if (containsMount(source)) throw new FsError('A disk is mounted inside this folder. Unmount it first.')
              const errorsBefore = handle.job.errors.length
              await copyTree(source, target, handle)
              if (handle.job.errors.length === errorsBefore) await rm(source, { recursive: true, force: true })
              else handle.job.errors.push(`${source}: kept in place because part of it could not be copied.`)
            }
          } else {
            await copyTree(source, target, handle)
          }
          done += 1
        } catch (error) {
          if (handle.cancelled) {
            // Leave no half-copied file behind. The job already shows as cancelled while this runs.
            if (input.op === 'copy' || (await exists(source))) {
              handle.job.message = 'Cancelled. Removing the part already copied…'
              await rm(target, { recursive: true, force: true }).catch(() => undefined)
              handle.job.message = 'Cancelled. The part already copied was removed.'
            }
            throw error
          }
          handle.job.errors.push(`${source}: ${explain(error)}`)
        }
      }

      logActivity({
        area: 'files',
        action: `${input.op === 'copy' ? 'Copied' : 'Moved'} ${done === 1 ? '1 item' : `${done} items`}`,
        target: destination,
        detail: [...sources, ...handle.job.errors].join('\n'),
        ok: handle.job.errors.length === 0,
      })
      return `${done === 1 ? '1 item' : `${done} items`} ${input.op === 'copy' ? 'copied' : 'moved'}.`
    },
  )
}

export async function startDelete(inputs: unknown[]) {
  const targets = inputs.slice(0, 5000).map(path)
  if (!targets.length) throw new FsError('Nothing selected.')
  for (const target of targets) {
    mustRemove(target)
    if (containsMount(target)) throw new FsError(`A disk is mounted inside ${target}. Unmount it first.`)
  }
  const title = targets.length === 1 ? `Deleting ${basename(targets[0]!)}` : `Deleting ${targets.length} items`
  return startJob(
    { kind: 'delete', title, unit: 'items', total: targets.length, folders: [...new Set(targets.map((target) => dirname(target)))] },
    async (handle) => {
      let freed = 0
      const removed: string[] = []
      // Both steps are programs, so cancelling stops them at once, even in the middle of a large folder.
      handle.onCancel(() => {
        logActivity({
          area: 'files',
          action: 'Deleting cancelled',
          target: targets.length === 1 ? targets[0] : dirname(targets[0]!),
          detail: removed.length ? `Already deleted:\n${removed.join('\n')}` : 'Nothing was fully deleted; part of the current item may be gone.',
          ok: false,
          freed,
        })
      })
      for (const target of targets) {
        handle.check()
        handle.job.now = target
        try {
          const size = await sizeOf(target)
          const result = await run(['rm', '-rf', '--one-file-system', '--', target], { timeout: 0 })
          if (!result.ok) throw new FsError(reason(result, 'It could not be deleted.'))
          removed.push(target)
          freed += size
        } catch (error) {
          if (handle.cancelled) throw error
          handle.job.errors.push(`${target}: ${explain(error)}`)
        }
        handle.job.done += 1
      }
      logActivity({
        area: 'files',
        action: targets.length === 1 ? 'Deleted for good' : `Deleted ${targets.length} items for good`,
        target: targets.length === 1 ? targets[0] : dirname(targets[0]!),
        detail: [...(targets.length > 1 ? targets : []), ...handle.job.errors].join('\n'),
        ok: handle.job.errors.length === 0,
        freed,
      })
      return `${targets.length - handle.job.errors.length} deleted.`
    },
  )
}

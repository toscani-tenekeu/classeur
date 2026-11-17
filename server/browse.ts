import { chmod, lchown, lstat, open, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { logActivity } from './db.ts'
import { FsError, type Kind, modeString, mustWrite, path } from './fsops.ts'
import { startJob } from './jobs.ts'
import { accounts, names } from './users.ts'

// ---- Search -----------------------------------------------------------------------------

const SKIP = new Set(['/proc', '/sys', '/dev', '/run'])

export interface SearchInput {
  path: unknown
  query: unknown
  extensions: string[]
  minBytes: number
  days: number
  olderThan: boolean
  kind: 'any' | 'file' | 'directory'
}

function matcher(query: string): ((name: string) => boolean) | null {
  const text = query.trim().toLowerCase()
  if (!text) return null
  if (text.includes('*') || text.includes('?')) {
    const pattern = new RegExp(`^${text.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
    return (name) => pattern.test(name.toLowerCase())
  }
  return (name) => name.toLowerCase().includes(text)
}

/** Walks a folder for matching files. Stops after 2000 results or two minutes. */
export async function search(input: SearchInput) {
  const root = path(input.path)
  const byName = matcher(typeof input.query === 'string' ? input.query : '')
  const extensions = input.extensions.map((item) => item.trim().replace(/^[*.]+/, '').toLowerCase()).filter(Boolean)
  if (extensions.some((item) => !/^[a-z0-9][a-z0-9.+_-]{0,19}$/.test(item))) throw new FsError('Extensions can only contain letters, digits, dots and dashes.')
  if (!byName && !extensions.length && !input.minBytes && !input.days) throw new FsError('Give a name, an extension, a size or a date to search for.')

  const limit = input.days ? Date.now() - input.days * 86_400_000 : 0
  const deadline = Date.now() + 120_000
  const who = await names()
  const results: { path: string; name: string; kind: Kind; size: number; modified: number; owner: string }[] = []
  let truncated = false
  let scanned = 0
  const queue = [root]

  while (queue.length && !truncated) {
    if (Date.now() > deadline) {
      truncated = true
      break
    }
    const dir = queue.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const item of entries) {
      const full = dir === '/' ? `/${item.name}` : `${dir}/${item.name}`
      scanned += 1
      if (item.isDirectory() && !item.isSymbolicLink() && !SKIP.has(full)) queue.push(full)
      const kind: Kind = item.isSymbolicLink() ? 'link' : item.isDirectory() ? 'directory' : item.isFile() ? 'file' : 'other'
      if (input.kind === 'file' && kind !== 'file') continue
      if (input.kind === 'directory' && kind !== 'directory') continue
      if (byName && !byName(item.name)) continue
      if (extensions.length && !extensions.some((extension) => item.name.toLowerCase().endsWith(`.${extension}`))) continue
      let info
      try {
        info = await lstat(full)
      } catch {
        continue
      }
      if (input.minBytes && (kind !== 'file' || info.size < input.minBytes)) continue
      if (limit && (input.olderThan ? info.mtimeMs >= limit : info.mtimeMs < limit)) continue
      results.push({
        path: full,
        name: item.name,
        kind,
        size: kind === 'directory' ? 0 : info.size,
        modified: info.mtimeMs,
        owner: who.user.get(info.uid) ?? String(info.uid),
      })
      if (results.length >= 2000) {
        truncated = true
        break
      }
    }
  }
  return { path: root, results, truncated, scanned }
}

// ---- Viewing ------------------------------------------------------------------------------

/** The last lines of a file, read from its end, so huge logs open instantly. */
export async function tail(input: unknown, count: number) {
  const target = path(input)
  const info = await stat(target)
  if (!info.isFile()) throw new FsError('Only files can be read.')
  const want = Math.min(5000, Math.max(10, count || 500))
  const length = Math.min(info.size, 2 * 1024 * 1024)
  const handle = await open(target, 'r')
  try {
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, info.size - length)
    const text = buffer.toString('utf8')
    const all = text.split('\n')
    if (length < info.size) all.shift()
    if (all.at(-1) === '') all.pop()
    return { path: target, size: info.size, modified: info.mtimeMs, lines: all.slice(-want) }
  } finally {
    await handle.close()
  }
}

// ---- Permissions and owners --------------------------------------------------------------------

const MODE = /^[0-7]{3,4}$/

async function walk(target: string, visit: (item: string, directory: boolean, link: boolean) => Promise<void>) {
  const info = await lstat(target)
  await visit(target, info.isDirectory(), info.isSymbolicLink())
  if (info.isDirectory() && !info.isSymbolicLink()) {
    for (const name of await readdir(target)) await walk(join(target, name), visit)
  }
}

export async function startPermissions(input: {
  paths: unknown[]
  fileMode?: unknown
  folderMode?: unknown
  user?: unknown
  group?: unknown
  recursive: boolean
}) {
  const targets = input.paths.slice(0, 5000).map(path)
  if (!targets.length) throw new FsError('Nothing selected.')
  for (const target of targets) mustWrite(target)

  const fileMode = typeof input.fileMode === 'string' && input.fileMode ? input.fileMode : null
  const folderMode = typeof input.folderMode === 'string' && input.folderMode ? input.folderMode : null
  if ((fileMode && !MODE.test(fileMode)) || (folderMode && !MODE.test(folderMode))) throw new FsError('Permissions are three or four digits from 0 to 7, like 755.')

  const { users, groups } = await accounts()
  const user = typeof input.user === 'string' && input.user ? users.find((account) => account.name === input.user) : undefined
  const group = typeof input.group === 'string' && input.group ? groups.find((account) => account.name === input.group) : undefined
  if (input.user && !user) throw new FsError('That user does not exist on this server.')
  if (input.group && !group) throw new FsError('That group does not exist on this server.')
  if (!fileMode && !folderMode && !user && !group) throw new FsError('Nothing to change.')

  const changes = [
    fileMode || folderMode ? `permissions ${[fileMode && `files ${fileMode}`, folderMode && `folders ${folderMode}`].filter(Boolean).join(', ')}` : '',
    user || group ? `owner ${user?.name ?? '…'}:${group?.name ?? '…'}` : '',
  ].filter(Boolean).join('; ')

  return startJob(
    {
      kind: 'permissions',
      title: `Changing ${targets.length === 1 ? basename(targets[0]!) : `${targets.length} items`}`,
      unit: 'items',
      folders: [...new Set(targets.map((target) => dirname(target)))],
    },
    async (handle) => {
      const apply = async (item: string, directory: boolean, link: boolean) => {
        handle.check()
        try {
          if (user || group) {
            const info = await lstat(item)
            await lchown(item, user?.id ?? info.uid, group?.id ?? info.gid)
          }
          // Links have no permissions of their own on Linux.
          if (!link) {
            const mode = directory ? folderMode : fileMode
            if (mode) await chmod(item, Number.parseInt(mode, 8))
          }
        } catch (error) {
          handle.job.errors.push(`${item}: ${error instanceof Error ? error.message : String(error)}`)
        }
        handle.job.done += 1
      }
      for (const target of targets) {
        if (input.recursive) await walk(target, apply)
        else {
          const info = await lstat(target)
          await apply(target, info.isDirectory(), info.isSymbolicLink())
        }
      }
      logActivity({
        area: 'permissions',
        action: 'Changed',
        target: targets.length === 1 ? targets[0] : dirname(targets[0]!),
        detail: `${changes}${input.recursive ? ', including everything inside' : ''}\n${handle.job.errors.join('\n')}`.trim(),
        ok: handle.job.errors.length === 0,
      })
      return `${handle.job.done} ${handle.job.done === 1 ? 'item' : 'items'} changed.`
    },
  )
}

export { modeString }

import { randomUUID } from 'node:crypto'
import { chown, lstat, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { logActivity } from './db.ts'
import { explain, FsError, mustWrite, path, validName } from './fsops.ts'
import { startJob } from './jobs.ts'
import { type Conflict, freeName, trashItems } from './transfer.ts'

interface Upload {
  id: string
  final: string
  part: string
  size: number
  received: number
  conflict: Conflict
  touched: number
}

const uploads = new Map<string, Upload>()
const exists = (target: string) => lstat(target).then(() => true, () => false)

/** The owner of the folder a file lands in becomes its owner, instead of root. */
async function adopt(target: string) {
  const parent = await stat(dirname(target)).catch(() => null)
  if (parent && parent.uid !== 0) await chown(target, parent.uid, parent.gid).catch(() => undefined)
}

export async function startUpload(input: { dir: unknown; relative: unknown; size: unknown; conflict: unknown }) {
  const dir = path(input.dir)
  const size = Number(input.size)
  if (!Number.isSafeInteger(size) || size < 0) throw new FsError('Invalid size.')
  if (typeof input.relative !== 'string' || !input.relative) throw new FsError('Give a file name.')

  // Folder uploads keep their inner folders: "photos/2024/a.jpg".
  const parts = input.relative.split('/').filter(Boolean).map(validName)
  const name = parts.pop()!
  let folder = dir
  for (const part of parts) {
    folder = join(folder, part)
    mustWrite(folder)
    if (!(await exists(folder))) {
      await mkdir(folder)
      await adopt(folder)
    }
  }
  const final = join(folder, name)
  mustWrite(final)
  const conflict: Conflict = input.conflict === 'overwrite' || input.conflict === 'skip' ? input.conflict : 'rename'
  if (conflict === 'skip' && (await exists(final))) return { id: null, skipped: true }

  const id = randomUUID()
  const part = join(folder, `.${name}.${id.slice(0, 8)}.part`)
  try {
    await (await open(part, 'wx', 0o644)).close()
  } catch (error) {
    throw new FsError(explain(error))
  }
  uploads.set(id, { id, final, part, size, received: 0, conflict, touched: Date.now() })
  return { id, skipped: false }
}

export async function receiveChunk(id: string, offset: number, chunk: ArrayBuffer) {
  const upload = uploads.get(id)
  if (!upload) throw new FsError('This upload is no longer known. Start it again.', 404)
  if (offset !== upload.received) throw new FsError(`Expected the part starting at byte ${upload.received}.`, 409)
  if (upload.received + chunk.byteLength > upload.size) throw new FsError('More data than announced.')
  const handle = await open(upload.part, 'a')
  try {
    await handle.write(new Uint8Array(chunk))
  } finally {
    await handle.close()
  }
  upload.received += chunk.byteLength
  upload.touched = Date.now()
  return { received: upload.received }
}

export async function finishUpload(id: string) {
  const upload = uploads.get(id)
  if (!upload) throw new FsError('This upload is no longer known. Start it again.', 404)
  if (upload.received !== upload.size) throw new FsError('The file did not arrive completely.')
  let final = upload.final
  if (await exists(final)) {
    if (upload.conflict === 'overwrite') {
      const outcome = await trashItems([final])
      if (!outcome.ok) throw new FsError(outcome.failed[0]?.message ?? 'The existing file could not be replaced.')
    } else {
      final = await freeName(dirname(final), basename(final))
    }
  }
  await rename(upload.part, final)
  await adopt(final)
  uploads.delete(id)
  logActivity({ area: 'upload', action: 'Uploaded', target: final, detail: `${upload.size} bytes` })
  return { ok: true, path: final }
}

export async function cancelUpload(id: string) {
  const upload = uploads.get(id)
  if (!upload) return
  uploads.delete(id)
  await rm(upload.part, { force: true })
}

/** Unfinished uploads are cleared after a day of silence. */
export function startUploadCleanup() {
  setInterval(() => {
    for (const upload of uploads.values()) {
      if (Date.now() - upload.touched > 86_400_000) void cancelUpload(upload.id)
    }
  }, 3_600_000)
}

// ---- Download from a URL straight to the server -------------------------------------------

export async function startFetch(input: { url: unknown; dir: unknown; name: unknown }) {
  const dir = path(input.dir)
  let url: URL
  try {
    url = new URL(String(input.url))
  } catch {
    throw new FsError('That is not a web address.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FsError('Only http and https addresses can be downloaded.')
  const fallback = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? '') || 'download'
  const name = validName(typeof input.name === 'string' && input.name.trim() ? input.name : fallback)
  let final = join(dir, name)
  mustWrite(final)
  if (await exists(final)) final = await freeName(dir, name)

  return startJob(
    { kind: 'fetch', title: `Downloading ${basename(final)}`, unit: 'bytes', folders: [dir] },
    async (handle) => {
      const abort = new AbortController()
      handle.onCancel(() => abort.abort())
      const part = `${final}.part`
      try {
        const response = await fetch(url, { signal: abort.signal, redirect: 'follow' })
        if (!response.ok || !response.body) throw new FsError(`The server answered ${response.status} ${response.statusText}.`)
        handle.job.total = Number(response.headers.get('content-length')) || 0
        const file = await open(part, 'wx', 0o644)
        try {
          for await (const chunk of response.body) {
            await file.write(chunk)
            handle.job.done += chunk.byteLength
          }
        } finally {
          await file.close()
        }
        await rename(part, final)
        await adopt(final)
      } catch (error) {
        await rm(part, { force: true })
        if (handle.cancelled) handle.check()
        logActivity({ area: 'upload', action: 'Download failed', target: url.href, detail: explain(error), ok: false })
        throw new FsError(explain(error, 'The download failed.'))
      }
      logActivity({ area: 'upload', action: 'Downloaded from the web', target: final, detail: url.href })
      return `Saved as ${final}.`
    },
  )
}

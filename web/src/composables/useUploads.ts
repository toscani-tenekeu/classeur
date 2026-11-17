import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import { api, ApiError, messageOf } from '@/lib/api'

export interface Upload {
  key: number
  name: string
  dir: string
  size: number
  sent: number
  state: 'waiting' | 'sending' | 'done' | 'failed' | 'cancelled' | 'skipped'
  error: string | null
}

export type Conflict = 'rename' | 'overwrite' | 'skip'

export const uploads = ref<Upload[]>([])
export const activeUploads = computed(() => uploads.value.filter((item) => item.state === 'waiting' || item.state === 'sending'))

const CHUNK = 8 * 1024 * 1024
let counter = 0
const queue: { item: Upload; file: File; relative: string; conflict: Conflict; done: (dir: string) => void }[] = []
const stopped = new Set<number>()
let busy = false

async function send(job: (typeof queue)[number]) {
  const { item, file } = job
  item.state = 'sending'
  const started = await api<{ id: string | null; skipped: boolean }>('/upload', {
    method: 'POST',
    body: { dir: item.dir, relative: job.relative, size: file.size, conflict: job.conflict },
  })
  if (started.skipped || !started.id) {
    item.state = 'skipped'
    return
  }
  const id = started.id
  for (let offset = 0; offset < file.size || (offset === 0 && file.size === 0); offset += CHUNK) {
    if (stopped.has(item.key)) {
      await api(`/upload/${id}`, { method: 'DELETE' }).catch(() => undefined)
      item.state = 'cancelled'
      return
    }
    if (file.size === 0) break
    const part = file.slice(offset, offset + CHUNK)
    let attempt = 0
    // A dropped connection is retried a few times before giving up.
    for (;;) {
      try {
        const response = await fetch(`/api/upload/${id}?offset=${offset}`, {
          method: 'PUT',
          body: part,
          headers: { 'Content-Type': 'application/octet-stream' },
        })
        if (!response.ok) {
          const data = await response.json().catch(() => null)
          throw new ApiError(data?.message ?? 'The upload failed.', response.status)
        }
        break
      } catch (failure) {
        attempt += 1
        if (attempt >= 3 || (failure instanceof ApiError && failure.status < 500 && failure.status !== 0)) throw failure
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt))
      }
    }
    item.sent = Math.min(file.size, offset + part.size)
  }
  await api(`/upload/${id}/finish`, { method: 'POST', body: {} })
  item.sent = item.size
  item.state = 'done'
}

async function pump() {
  if (busy) return
  busy = true
  const touched = new Map<string, (dir: string) => void>()
  while (queue.length) {
    const job = queue.shift()!
    if (stopped.has(job.item.key)) {
      job.item.state = 'cancelled'
      continue
    }
    try {
      await send(job)
    } catch (failure) {
      job.item.state = 'failed'
      job.item.error = messageOf(failure)
    }
    touched.set(job.item.dir, job.done)
  }
  busy = false
  const failed = uploads.value.filter((item) => item.state === 'failed').length
  const done = uploads.value.filter((item) => item.state === 'done').length
  if (failed) toast.error(`${failed} ${failed === 1 ? 'upload' : 'uploads'} failed.`)
  else if (done) toast.success(done === 1 ? 'Upload finished.' : `${done} uploads finished.`)
  for (const [dir, done] of touched) done(dir)
}

export function enqueue(
  dir: string,
  files: { file: File; relative: string }[],
  conflict: Conflict,
  done: (dir: string) => void,
) {
  for (const { file, relative } of files) {
    const item: Upload = { key: ++counter, name: relative, dir, size: file.size, sent: 0, state: 'waiting', error: null }
    uploads.value.push(item)
    // Work on the reactive copy so progress shows up in the interface.
    queue.push({ item: uploads.value.at(-1)!, file, relative, conflict, done })
  }
  void pump()
}

export function cancelUpload(item: Upload) {
  stopped.add(item.key)
  if (item.state === 'waiting') item.state = 'cancelled'
}

export function clearUploads() {
  uploads.value = uploads.value.filter((item) => item.state === 'waiting' || item.state === 'sending')
}

/** Reads files and whole folders from a drop, keeping the folder structure. */
export async function filesFromDrop(transfer: DataTransfer): Promise<{ file: File; relative: string }[]> {
  const entries = [...transfer.items]
    .map((item) => (item.kind === 'file' ? item.webkitGetAsEntry?.() : null))
    .filter((entry): entry is FileSystemEntry => Boolean(entry))
  if (!entries.length) return [...transfer.files].map((file) => ({ file, relative: file.name }))

  const out: { file: File; relative: string }[] = []
  async function visit(entry: FileSystemEntry, prefix: string) {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
      out.push({ file, relative: `${prefix}${entry.name}` })
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader()
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
        if (!batch.length) break
        for (const child of batch) await visit(child, `${prefix}${entry.name}/`)
      }
    }
  }
  for (const entry of entries) await visit(entry, '')
  return out
}

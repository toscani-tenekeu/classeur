import { lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { logActivity } from './db.ts'
import { FsError, mustWrite, path } from './fsops.ts'
import { startJob } from './jobs.ts'
import { freeName, sizeOf } from './transfer.ts'
import { reason, run, spawn } from './sys.ts'

type Format = 'zip' | 'tar' | 'tar.gz' | 'tar.xz' | 'tar.bz2' | 'tar.zst' | 'gz' | 'xz' | 'bz2' | '7z' | 'rar'

const SUFFIXES: [string, Format][] = [
  ['.tar.gz', 'tar.gz'], ['.tgz', 'tar.gz'], ['.tar.xz', 'tar.xz'], ['.txz', 'tar.xz'],
  ['.tar.bz2', 'tar.bz2'], ['.tbz2', 'tar.bz2'], ['.tbz', 'tar.bz2'], ['.tar.zst', 'tar.zst'], ['.tzst', 'tar.zst'],
  ['.tar', 'tar'], ['.zip', 'zip'], ['.jar', 'zip'], ['.war', 'zip'], ['.7z', '7z'], ['.rar', 'rar'],
  ['.gz', 'gz'], ['.xz', 'xz'], ['.bz2', 'bz2'],
]

export function formatOf(name: string): { format: Format; stem: string } | null {
  const lower = name.toLowerCase()
  for (const [suffix, format] of SUFFIXES) {
    if (lower.endsWith(suffix) && lower.length > suffix.length) return { format, stem: name.slice(0, -suffix.length) }
  }
  return null
}

const TAR_FLAG: Partial<Record<Format, string[]>> = {
  tar: [], 'tar.gz': ['-z'], 'tar.xz': ['-J'], 'tar.bz2': ['-j'], 'tar.zst': ['--zstd'],
}

const sevenZip = () => Bun.which('7z') ?? Bun.which('7zz') ?? Bun.which('7za')

function tool(format: Format): string | null {
  if (format === 'zip') return Bun.which('unzip') ? null : 'unzip'
  if (format in TAR_FLAG) return Bun.which('tar') ? (format === 'tar.zst' && !Bun.which('zstd') ? 'zstd' : null) : 'tar'
  if (format === '7z' || format === 'rar') return sevenZip() ? null : '7-Zip (7z)'
  return Bun.which(format === 'gz' ? 'gzip' : format === 'xz' ? 'xz' : 'bzip2') ? null : format
}

export interface ArchiveEntry {
  name: string
  size: number
  directory: boolean
}

/** What is inside an archive, without extracting it. */
export async function listArchive(input: unknown) {
  const target = path(input)
  const found = formatOf(basename(target))
  if (!found) throw new FsError('This is not an archive Classeur knows.')
  const missing = tool(found.format)
  if (missing) throw new FsError(`Install ${missing} on the server to open this archive.`)
  const { format } = found
  const entries: ArchiveEntry[] = []

  if (format === 'zip') {
    const result = await run(['unzip', '-l', '--', target], { timeout: 60_000 })
    if (!result.ok) throw new FsError(reason(result, 'The archive could not be read.'))
    for (const line of result.stdout.split('\n')) {
      const match = line.match(/^\s*(\d+)\s+\S+\s+\S+\s+(.+)$/)
      if (match && !/^-+$/.test(match[2]!.trim()) && match[2] !== 'Name') {
        entries.push({ name: match[2]!, size: Number(match[1]), directory: match[2]!.endsWith('/') })
      }
    }
  } else if (format in TAR_FLAG) {
    const result = await run(['tar', ...TAR_FLAG[format]!, '-tvf', target], { timeout: 120_000 })
    if (!result.ok) throw new FsError(reason(result, 'The archive could not be read.'))
    for (const line of result.stdout.split('\n')) {
      // drwxr-xr-x user/group 0 2024-01-01 10:00 name
      const match = line.match(/^(\S)\S*\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.+?)(?: -> .*)?$/)
      if (match) entries.push({ name: match[3]!, size: Number(match[2]), directory: match[1] === 'd' })
    }
  } else if (format === '7z' || format === 'rar') {
    const result = await run([sevenZip()!, 'l', '-slt', '-ba', '--', target], { timeout: 120_000 })
    if (!result.ok) throw new FsError(reason(result, 'The archive could not be read.'))
    for (const block of result.stdout.split(/\n\s*\n/)) {
      const name = block.match(/^Path = (.+)$/m)?.[1]
      if (!name) continue
      entries.push({
        name,
        size: Number(block.match(/^Size = (\d+)$/m)?.[1] ?? 0),
        directory: /^Attributes = D/m.test(block) || /^Folder = \+/m.test(block),
      })
    }
  } else {
    const info = await stat(target)
    entries.push({ name: found.stem, size: info.size, directory: false })
  }

  const total = entries.reduce((sum, entry) => sum + entry.size, 0)
  return { path: target, format, count: entries.length, total, truncated: entries.length > 2000, entries: entries.slice(0, 2000) }
}

/** Gives extracted files to the owner of the folder they land in, instead of root. */
async function adopt(target: string, parent: string) {
  const owner = await stat(parent).catch(() => null)
  if (!owner || owner.uid === 0) return
  await run(['chown', '-R', '-h', '--', `${owner.uid}:${owner.gid}`, target], { timeout: 300_000 })
}

/** The size of a folder being filled, for progress; nothing when the job is gone. */
async function quickSize(dir: string): Promise<number> {
  try {
    return await sizeOf(dir)
  } catch {
    return 0
  }
}

export async function startExtract(input: unknown, destinationInput: unknown) {
  const archive = path(input)
  const found = formatOf(basename(archive))
  if (!found) throw new FsError('This is not an archive Classeur knows.')
  const missing = tool(found.format)
  if (missing) throw new FsError(`Install ${missing} on the server to extract this archive.`)

  const parent = destinationInput ? path(destinationInput) : dirname(archive)
  mustWrite(parent)
  const single = ['gz', 'xz', 'bz2'].includes(found.format)

  return startJob(
    { kind: 'extract', title: `Extracting ${basename(archive)}`, unit: 'bytes', folders: [parent] },
    async (handle) => {
      // Unpack into a hidden folder first, then put the result in place in one step.
      const work = join(parent, `.${found.stem}.classeur-extract-${Date.now()}`)
      await mkdir(work)
      try {
        let command: string[]
        if (single) {
          const program = found.format === 'gz' ? 'gzip' : found.format === 'xz' ? 'xz' : 'bzip2'
          command = ['sh', '-c', `${program} -dc -- "$1" > "$2"`, 'extract', archive, join(work, found.stem)]
        } else if (found.format === 'zip') command = ['unzip', '-q', '-o', archive, '-d', work]
        else if (found.format in TAR_FLAG) {
          // GNU tar refuses names with ".." and strips leading slashes by default.
          command = ['tar', ...TAR_FLAG[found.format]!, '-xf', archive, '-C', work, '--no-same-owner']
        } else command = [sevenZip()!, 'x', '-y', `-o${work}`, '--', archive]

        // Its own process group: cancelling kills the shell and the decompressor it started.
        const proc = spawn(command, { timeout: 0 })
        const timer = setInterval(() => void quickSize(work).then((size) => (handle.job.done = size)), 1500)
        const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
        clearInterval(timer)
        handle.check()
        if (code !== 0) {
          const message = stderr.trim().split('\n').at(-1) || 'The archive could not be extracted.'
          logActivity({ area: 'archive', action: 'Extract failed', target: archive, detail: message, ok: false })
          throw new FsError(message)
        }
        handle.job.done = await sizeOf(work)

        // An archive holding one folder (or one file) lands as that item; anything else gets its own folder.
        const inside = await readdir(work)
        let target: string
        if (inside.length === 1) {
          const name = inside[0]!
          target = join(parent, name)
          if (await lstat(target).then(() => true, () => false)) target = await freeName(parent, name)
          await rename(join(work, name), target)
          await rm(work, { recursive: true, force: true })
        } else {
          target = join(parent, found.stem)
          if (await lstat(target).then(() => true, () => false)) target = await freeName(parent, found.stem)
          await rename(work, target)
        }
        await adopt(target, parent)
        logActivity({ area: 'archive', action: 'Extracted', target: `${archive} → ${target}` })
        return `Extracted to ${target}.`
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => undefined)
      }
    },
  )
}

export type CreateFormat = 'zip' | 'tar.gz' | 'tar.xz'

export async function startCompress(inputs: unknown[], nameInput: unknown, format: CreateFormat) {
  const sources = inputs.slice(0, 5000).map(path)
  if (!sources.length) throw new FsError('Nothing selected.')
  const parent = dirname(sources[0]!)
  if (sources.some((source) => dirname(source) !== parent)) throw new FsError('Pick items from one folder.')
  if (!['zip', 'tar.gz', 'tar.xz'].includes(format)) throw new FsError('Unknown format.')
  if (format === 'zip' && !Bun.which('zip')) throw new FsError('Install zip on the server to make zip archives, or choose tar.gz.')

  const base = typeof nameInput === 'string' && nameInput.trim() ? nameInput.trim() : basename(sources[0]!)
  if (base.includes('/')) throw new FsError('A name cannot contain a slash.')
  const name = base.toLowerCase().endsWith(`.${format}`) ? base : `${base}.${format}`
  let target = join(parent, name)
  if (await lstat(target).then(() => true, () => false)) target = await freeName(parent, name)
  mustWrite(target)

  const names = sources.map((source) => basename(source))
  const command =
    format === 'zip'
      ? ['zip', '-r', '-q', '-y', target, '--', ...names]
      : ['tar', format === 'tar.gz' ? '-czf' : '-cJf', target, '--', ...names]

  let total = 0
  for (const source of sources) total += await sizeOf(source)

  return startJob(
    { kind: 'compress', title: `Compressing ${names.length === 1 ? names[0] : `${names.length} items`}`, unit: 'bytes', total: 0, folders: [parent] },
    async (handle) => {
      const proc = spawn(command, { cwd: parent, timeout: 0, stdout: 'ignore' })
      const timer = setInterval(() => void Bun.file(target).exists().then((there) => there && (handle.job.done = Bun.file(target).size)), 1000)
      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
      clearInterval(timer)
      if (handle.cancelled) {
        await Bun.file(target).delete().catch(() => undefined)
        handle.check()
      }
      if (code !== 0) {
        await Bun.file(target).delete().catch(() => undefined)
        const message = stderr.trim().split('\n').at(-1) || 'The archive could not be made.'
        logActivity({ area: 'archive', action: 'Compress failed', target, detail: message, ok: false })
        throw new FsError(message)
      }
      await adopt(target, parent)
      const size = Bun.file(target).size
      handle.job.done = size
      logActivity({ area: 'archive', action: 'Compressed', target, detail: names.join('\n') })
      return `${basename(target)} made: ${(size / 1024 / 1024).toFixed(1)} MB from ${(total / 1024 / 1024).toFixed(1)} MB.`
    },
  )
}

/** Streams several items, or a folder, as one zip, without writing it to disk first. */
export function zipStream(inputs: string[]): { body: ReadableStream; name: string; type: string } {
  const sources = inputs.map(path)
  const parent = dirname(sources[0]!)
  if (sources.some((source) => dirname(source) !== parent)) throw new FsError('Pick items from one folder.')
  const names = sources.map((source) => basename(source))
  const label = names.length === 1 ? names[0]! : basename(parent) || 'files'
  const useZip = Boolean(Bun.which('zip'))
  const command = useZip ? ['zip', '-r', '-q', '-y', '-', '--', ...names] : ['tar', '-czf', '-', '--', ...names]
  // Stops when the browser stops the download.
  const proc = spawn(command, { cwd: parent, timeout: 0 })
  logActivity({ area: 'files', action: 'Downloaded as an archive', target: sources.length === 1 ? sources[0] : parent, detail: names.join('\n') })
  return {
    body: proc.stdout as ReadableStream,
    name: `${label}.${useZip ? 'zip' : 'tar.gz'}`,
    type: useZip ? 'application/zip' : 'application/gzip',
  }
}

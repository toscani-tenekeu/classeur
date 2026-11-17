import { constants } from 'node:fs'
import { access, lstat, mkdir, open, readdir, readlink, realpath, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { config } from './config.ts'
import { logActivity } from './db.ts'
import { clean, isSensitive, removeBlock, writeBlock } from './paths.ts'
import { lines, reason, run } from './sys.ts'
import { names } from './users.ts'

export type Kind = 'file' | 'directory' | 'link' | 'other'

export interface Entry {
  name: string
  path: string
  kind: Kind
  /** For links: what the link points to, and what kind of thing that is. */
  target: string | null
  targetKind: Kind | null
  size: number
  modified: number
  mode: string
  owner: string
  group: string
  hidden: boolean
}

export class FsError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

export function explain(error: unknown, fallback = 'The operation failed.'): string {
  if (error instanceof FsError) return error.message
  const code = (error as NodeJS.ErrnoException)?.code
  switch (code) {
    case 'ENOENT': return 'It does not exist any more.'
    case 'EEXIST': return 'Something with that name already exists.'
    case 'EACCES':
    case 'EPERM': return 'Permission denied.'
    case 'ENOTEMPTY': return 'The folder is not empty.'
    case 'ENOSPC': return 'The disk is full.'
    case 'EROFS': return 'This disk is mounted read-only.'
    case 'EISDIR': return 'This is a folder.'
    case 'ENOTDIR': return 'This is not a folder.'
    case 'EXDEV': return 'It is on another disk.'
    case 'ENAMETOOLONG': return 'The name is too long.'
    case 'EBUSY': return 'It is in use.'
    default: return error instanceof Error ? error.message : fallback
  }
}

const kindOf = (info: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): Kind =>
  info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'

export const modeString = (mode: number) => (mode & 0o7777).toString(8).padStart(4, '0')

export function path(input: unknown): string {
  const value = clean(input)
  if (!value) throw new FsError('Invalid path.')
  return value
}

/** A single file or folder name: no slashes, nothing hidden in it. */
export function validName(input: unknown): string {
  if (typeof input !== 'string') throw new FsError('Give a name.')
  const name = input.trim()
  if (!name || name === '.' || name === '..') throw new FsError('Give a name.')
  if (name.includes('/') || name.includes('\0')) throw new FsError('A name cannot contain a slash.')
  if (Buffer.byteLength(name) > 255) throw new FsError('The name is too long.')
  return name
}

export function mustWrite(target: string) {
  const blocked = writeBlock(target)
  if (blocked) throw new FsError(blocked, 403)
}

export function mustRemove(target: string) {
  const blocked = removeBlock(target)
  if (blocked) throw new FsError(blocked, 403)
}

async function entry(dir: string, name: string, who: Awaited<ReturnType<typeof names>>): Promise<Entry | null> {
  const full = dir === '/' ? `/${name}` : `${dir}/${name}`
  let info
  try {
    info = await lstat(full)
  } catch {
    return null
  }
  const kind = kindOf(info)
  let target: string | null = null
  let targetKind: Kind | null = null
  let size = info.size
  if (kind === 'link') {
    target = await readlink(full).catch(() => null)
    const pointed = await stat(full).catch(() => null)
    targetKind = pointed ? kindOf(pointed) : null
    if (pointed?.isFile()) size = pointed.size
  }
  return {
    name,
    path: full,
    kind,
    target,
    targetKind,
    size: kind === 'directory' ? 0 : size,
    modified: info.mtimeMs,
    mode: modeString(info.mode),
    owner: who.user.get(info.uid) ?? String(info.uid),
    group: who.group.get(info.gid) ?? String(info.gid),
    hidden: name.startsWith('.'),
  }
}

async function canWrite(target: string): Promise<boolean> {
  if (writeBlock(target)) return false
  return access(target, constants.W_OK).then(() => true, () => false)
}

export async function list(input: unknown) {
  const dir = path(input)
  let names_: string[]
  try {
    const info = await stat(dir)
    if (!info.isDirectory()) throw new FsError('This is not a folder.')
    names_ = await readdir(dir)
  } catch (error) {
    throw new FsError(explain(error, 'The folder cannot be read.'), 404)
  }
  const who = await names()
  const entries: Entry[] = []
  // Read the details in batches so a folder with 100 000 files does not open them all at once.
  for (let index = 0; index < names_.length; index += 256) {
    const batch = await Promise.all(names_.slice(index, index + 256).map((name) => entry(dir, name, who)))
    for (const item of batch) if (item) entries.push(item)
  }
  return {
    path: dir,
    parent: dir === '/' ? null : dirname(dir),
    writable: await canWrite(dir),
    protected: writeBlock(dir),
    entries,
  }
}

export async function details(input: unknown) {
  const target = path(input)
  const who = await names()
  const item = await entry(dirname(target), basename(target) || '/', who)
  if (!item) throw new FsError('It does not exist any more.', 404)
  const info = await lstat(target)
  return {
    ...item,
    path: target,
    accessed: info.atimeMs,
    changed: info.ctimeMs,
    created: info.birthtimeMs || null,
    inode: info.ino,
    links: info.nlink,
    uid: info.uid,
    gid: info.gid,
    writable: await canWrite(target),
    removable: removeBlock(target) === null,
    sensitive: isSensitive(target),
  }
}

/** Disk space used by a folder, counted by du so huge trees stay fast. */
export async function folderSize(input: unknown) {
  const target = path(input)
  // -x stays on one disk; -k is understood by GNU and BusyBox du alike.
  const result = await run(['du', '-skx', '--', target], { timeout: 300_000 })
  const kb = Number(lines(result.stdout).at(-1)?.split(/\s+/)[0])
  if (!Number.isFinite(kb)) throw new FsError(reason(result, 'The size could not be measured.'))
  return { path: target, size: kb * 1024, complete: result.ok }
}

export async function makeFolder(parentInput: unknown, nameInput: unknown) {
  const parent = path(parentInput)
  const target = join(parent, validName(nameInput))
  mustWrite(target)
  try {
    await mkdir(target)
  } catch (error) {
    throw new FsError(explain(error))
  }
  logActivity({ area: 'files', action: 'Created folder', target })
  return { ok: true, path: target }
}

export async function makeFile(parentInput: unknown, nameInput: unknown) {
  const parent = path(parentInput)
  const target = join(parent, validName(nameInput))
  mustWrite(target)
  try {
    await writeFile(target, '', { flag: 'wx', mode: 0o644 })
  } catch (error) {
    throw new FsError(explain(error))
  }
  logActivity({ area: 'files', action: 'Created file', target })
  return { ok: true, path: target }
}

export async function renameItem(input: unknown, nameInput: unknown) {
  const source = path(input)
  const target = join(dirname(source), validName(nameInput))
  if (target === source) return { ok: true, path: target }
  mustRemove(source)
  mustWrite(target)
  if (await lstat(target).then(() => true, () => false)) throw new FsError('Something with that name already exists here.')
  try {
    await rename(source, target)
  } catch (error) {
    throw new FsError(explain(error))
  }
  logActivity({ area: 'files', action: 'Renamed', target: `${source} → ${basename(target)}` })
  return { ok: true, path: target }
}

export async function makeLink(targetInput: unknown, parentInput: unknown, nameInput: unknown) {
  const pointsTo = path(targetInput)
  const parent = path(parentInput)
  const link = join(parent, validName(nameInput))
  mustWrite(link)
  try {
    await symlink(pointsTo, link)
  } catch (error) {
    throw new FsError(explain(error))
  }
  logActivity({ area: 'files', action: 'Created link', target: `${link} → ${pointsTo}` })
  return { ok: true, path: link }
}

// ---- Text editor ----------------------------------------------------------------

/** A NUL byte in the first 8 KB is the usual sign of a binary file. */
export async function looksBinary(target: string): Promise<boolean> {
  const handle = await open(target, 'r')
  try {
    const buffer = Buffer.alloc(8192)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).includes(0)
  } finally {
    await handle.close()
  }
}

export async function readText(input: unknown) {
  const target = path(input)
  let info
  try {
    info = await stat(target)
  } catch (error) {
    throw new FsError(explain(error), 404)
  }
  if (!info.isFile()) throw new FsError('Only files can be opened in the editor.')
  if (info.size > config.maxEditBytes) {
    throw new FsError(`The file is ${(info.size / 1024 / 1024).toFixed(1)} MB. Files up to 5 MB open in the editor; download it or view its end instead.`, 413)
  }
  if (await looksBinary(target)) throw new FsError('This is not a text file.', 415)
  const content = await Bun.file(target).text()
  return {
    path: target,
    content,
    modified: info.mtimeMs,
    size: info.size,
    writable: await canWrite(target),
    protected: writeBlock(target),
    sensitive: isSensitive(target),
    extension: extname(target).slice(1).toLowerCase(),
  }
}

/** Programs that can check a file before it replaces one the server depends on. */
async function validate(target: string, draft: string): Promise<string | null> {
  if (/^\/etc\/sudoers(\.d\/.*)?$/.test(target) && Bun.which('visudo')) {
    const result = await run(['visudo', '-c', '-q', '-f', draft])
    return result.ok ? null : `sudo would reject this file: ${reason(result, 'syntax error')}`
  }
  if (/^\/etc\/ssh\/sshd_config$/.test(target)) {
    const sshd = Bun.which('sshd') ?? '/usr/sbin/sshd'
    if (await Bun.file(sshd).exists()) {
      const result = await run([sshd, '-t', '-f', draft])
      return result.ok ? null : `The SSH server would reject this file: ${reason(result, 'syntax error')}`
    }
  }
  return null
}

export async function writeText(input: unknown, content: unknown, expected: unknown) {
  const given = path(input)
  if (typeof content !== 'string') throw new FsError('Nothing to save.')
  mustWrite(given)
  // Save into the real file behind a link, so the link itself stays a link.
  const target = await realpath(given).catch(() => given)
  mustWrite(target)
  let info
  try {
    info = await stat(target)
  } catch (error) {
    throw new FsError(explain(error), 404)
  }
  if (typeof expected === 'number' && Math.abs(info.mtimeMs - expected) > 1) {
    throw new FsError('The file changed on the server since you opened it. Reload it to see the new version.', 409)
  }

  // Write next to the file, check it, then swap it in, so a failed save never leaves half a file.
  const draft = join(dirname(target), `.${basename(target)}.classeur-${process.pid}-${Date.now()}`)
  try {
    await writeFile(draft, content, { mode: info.mode & 0o7777 })
    const problem = await validate(target, draft)
    if (problem) throw new FsError(problem, 422)
    await run(['chown', '--', `${info.uid}:${info.gid}`, draft])
    await rename(draft, target)
  } catch (error) {
    await unlink(draft).catch(() => undefined)
    throw new FsError(explain(error, 'The file could not be saved.'), error instanceof FsError ? error.status : 400)
  }
  const after = await stat(target)
  logActivity({ area: 'editor', action: 'Saved', target, detail: isSensitive(target) ? 'Sensitive system file' : '' })
  return { ok: true, modified: after.mtimeMs, size: after.size }
}

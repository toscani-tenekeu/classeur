import { existsSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { join, normalize } from 'node:path'
import {
  allowAttempt, checkPassword, checkSetupToken, createSession, endSession, ensureAdmin,
  finishSetup, isAuthed, sessionCookie, setPassword, setupFile, setupPending,
} from './auth.ts'
import { type CreateFormat, listArchive, startCompress, startExtract, zipStream } from './archive.ts'
import { search, startPermissions, tail } from './browse.ts'
import { config } from './config.ts'
import { db, getSetting, logActivity, setSetting } from './db.ts'
import {
  details, explain, folderSize, FsError, list, makeFile, makeFolder, makeLink, path as cleanPath, readText,
  renameItem, writeText,
} from './fsops.ts'
import { cancelJob, clearFinished, listJobs } from './jobs.ts'
import { purgeTrash, restoreItems, startDelete, startTransfer, startTrashPurge, trashItems, trashList } from './transfer.ts'
import { applyUpdate, checkForUpdate, setAutoUpdate, startUpdateChecks, updateState } from './update.ts'
import { cancelUpload, finishUpload, receiveChunk, startFetch, startUpload, startUploadCleanup } from './upload.ts'
import { accounts } from './users.ts'

if (process.platform !== 'linux') {
  console.error('Classeur only runs on Linux.')
  process.exit(1)
}

const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self'; frame-src 'self'; frame-ancestors 'none'",
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { ...HEADERS, 'Cache-Control': 'no-store', ...extra } })
}

const fail = (message: string, status = 400) => json({ ok: false, message }, status)

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const text = await req.text()
    if (text.length > 20_000_000) return {}
    const parsed: unknown = JSON.parse(text || '{}')
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** A browser on another site must never be able to trigger an action here. */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin')
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.get('host')
  } catch {
    return false
  }
}

function validPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 10 && value.length <= 200
}


const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** A Content-Disposition header that survives any file name. */
function disposition(type: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

const PREVIEWABLE = /^(image\/(png|jpeg|gif|webp|avif|bmp|x-icon|svg\+xml)|video\/(mp4|webm|ogg)|audio\/(mpeg|ogg|wav|webm|flac|aac|mp4|x-wav)|application\/pdf)$/

/**
 * Sends a file, with byte ranges so videos can be seeked. Anything shown in
 * the browser is locked down, so an uploaded page or SVG can never run code
 * with the signed-in session.
 */
async function sendFile(req: Request, input: unknown, download: boolean): Promise<Response> {
  const target = cleanPath(input)
  const info = await stat(target).catch(() => null)
  if (!info?.isFile()) return fail('This is not a file.', 404)
  const file = Bun.file(target)
  const name = target.split('/').at(-1) ?? 'file'
  const detected = file.type.split(';')[0] ?? 'application/octet-stream'
  const inline = !download && PREVIEWABLE.test(detected)
  const type = download ? 'application/octet-stream' : inline ? detected : 'text/plain; charset=utf-8'

  const headers: Record<string, string> = {
    'Content-Type': type,
    'Content-Disposition': disposition(download ? 'attachment' : 'inline', name),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy':
      detected === 'application/pdf' && !download
        ? "frame-ancestors 'self'"
        : "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'",
  }

  const range = req.headers.get('range')?.match(/^bytes=(\d*)-(\d*)$/)
  if (range && info.size > 0) {
    let start = range[1] ? Number(range[1]) : info.size - Number(range[2])
    let end = range[1] && range[2] ? Number(range[2]) : info.size - 1
    start = Math.max(0, start)
    end = Math.min(end, info.size - 1)
    if (start > end) {
      return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${info.size}` } })
    }
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': String(end - start + 1) },
    })
  }
  return new Response(file, { headers: { ...headers, 'Content-Length': String(info.size) } })
}

const DEFAULT_FAVOURITES = ['/', '/root', '/home', '/var/www', '/etc', '/var/log', '/opt', '/tmp']

function favourites(): string[] {
  try {
    const saved: unknown = JSON.parse(getSetting('favourites') ?? 'null')
    if (Array.isArray(saved)) return saved.filter((item): item is string => typeof item === 'string')
  } catch {
    // Fall back to the defaults below.
  }
  return DEFAULT_FAVOURITES.filter((item) => existsSync(item))
}

function setFavourites(paths: unknown[]): string[] {
  const clean = [...new Set(paths.map((item) => cleanPath(item)))].slice(0, 50)
  setSetting('favourites', JSON.stringify(clean))
  return clean
}

async function api(req: Request, url: URL, address: string): Promise<Response> {
  const path = url.pathname.slice('/api'.length)
  const route = `${req.method} ${path}`
  const query = url.searchParams

  if (req.method !== 'GET' && !sameOrigin(req)) return fail('Cross-site request refused.', 403)

  // Open routes
  if (route === 'GET /session') {
    return json({ signedIn: isAuthed(req), setupPending: setupPending() })
  }

  if (route === 'POST /setup') {
    if (!allowAttempt(address)) return fail('Too many attempts. Wait a minute and try again.', 429)
    const data = await body(req)
    if (typeof data.token !== 'string' || !checkSetupToken(data.token)) {
      return fail('This setup link is no longer valid. Sign in with your password instead.', 403)
    }
    if (!validPassword(data.password)) return fail('Use a password of at least 10 characters.')
    await setPassword(data.password)
    logActivity({ area: 'account', action: 'Setup completed' })
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(req, createSession()) })
  }

  if (route === 'POST /login') {
    if (!allowAttempt(address)) return fail('Too many attempts. Wait a minute and try again.', 429)
    const data = await body(req)
    if (typeof data.password !== 'string' || !(await checkPassword(data.password))) {
      return fail('Wrong password.', 401)
    }
    finishSetup()
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(req, createSession()) })
  }

  if (!isAuthed(req)) return fail('Sign in to continue.', 401)

  // Signed-in routes
  if (route === 'POST /logout') {
    endSession(req)
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(req, null) })
  }

  if (route === 'POST /password') {
    const data = await body(req)
    if (typeof data.current !== 'string' || !(await checkPassword(data.current))) {
      return fail('The current password is not correct.', 403)
    }
    if (!validPassword(data.password)) return fail('Use a password of at least 10 characters.')
    await setPassword(data.password)
    logActivity({ area: 'account', action: 'Password changed' })
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(req, createSession()) })
  }

  // ---- Browsing --------------------------------------------------------------
  if (route === 'GET /fs/list') return json(await list(query.get('path') ?? '/'))
  if (route === 'GET /fs/details') return json(await details(query.get('path')))
  if (route === 'GET /fs/size') return json(await folderSize(query.get('path')))
  if (route === 'GET /fs/search') {
    const kind = query.get('kind')
    return json(
      await search({
        path: query.get('path') ?? '/',
        query: query.get('q') ?? '',
        extensions: (query.get('ext') ?? '').split(/[\s,;]+/),
        minBytes: Number(query.get('min')) || 0,
        days: Number(query.get('days')) || 0,
        olderThan: query.get('older') === '1',
        kind: kind === 'file' || kind === 'directory' ? kind : 'any',
      }),
    )
  }
  if (route === 'GET /fs/raw') return await sendFile(req, query.get('path'), false)
  if (route === 'GET /fs/download') return await sendFile(req, query.get('path'), true)
  if (route === 'GET /fs/zip') {
    const paths = query.getAll('path')
    if (!paths.length) return fail('Nothing selected.')
    const stream = zipStream(paths)
    return new Response(stream.body, {
      headers: {
        ...HEADERS,
        'Content-Type': stream.type,
        'Content-Disposition': disposition('attachment', stream.name),
        'Cache-Control': 'no-store',
      },
    })
  }
  if (route === 'GET /fs/tail') return json(await tail(query.get('path'), Number(query.get('lines'))))
  if (route === 'GET /fs/text') return json(await readText(query.get('path')))
  if (route === 'GET /fs/archive') return json(await listArchive(query.get('path')))

  // ---- Changing ---------------------------------------------------------------
  if (route === 'POST /fs/folder') {
    const data = await body(req)
    return json(await makeFolder(data.parent, data.name))
  }
  if (route === 'POST /fs/file') {
    const data = await body(req)
    return json(await makeFile(data.parent, data.name))
  }
  if (route === 'POST /fs/rename') {
    const data = await body(req)
    return json(await renameItem(data.path, data.name))
  }
  if (route === 'POST /fs/link') {
    const data = await body(req)
    return json(await makeLink(data.target, data.parent, data.name))
  }
  if (route === 'PUT /fs/text') {
    const data = await body(req)
    return json(await writeText(data.path, data.content, data.modified))
  }
  if (route === 'POST /fs/transfer') {
    const data = await body(req)
    const conflict = data.conflict === 'overwrite' || data.conflict === 'skip' ? data.conflict : 'rename'
    return json(
      await startTransfer({
        op: data.op === 'move' ? 'move' : 'copy',
        sources: arrayOf(data.paths),
        destination: data.destination,
        conflict,
      }),
    )
  }
  if (route === 'POST /fs/trash') return json(await trashItems(arrayOf((await body(req)).paths)))
  if (route === 'POST /fs/delete') return json(await startDelete(arrayOf((await body(req)).paths)))
  if (route === 'POST /fs/permissions') {
    const data = await body(req)
    return json(
      await startPermissions({
        paths: arrayOf(data.paths),
        fileMode: data.fileMode,
        folderMode: data.folderMode,
        user: data.user,
        group: data.group,
        recursive: data.recursive === true,
      }),
    )
  }
  if (route === 'POST /fs/compress') {
    const data = await body(req)
    return json(await startCompress(arrayOf(data.paths), data.name, data.format as CreateFormat))
  }
  if (route === 'POST /fs/extract') {
    const data = await body(req)
    return json(await startExtract(data.path, data.destination))
  }
  if (route === 'POST /fs/fetch') {
    const data = await body(req)
    return json(await startFetch({ url: data.url, dir: data.dir, name: data.name }))
  }

  // ---- Uploads ----------------------------------------------------------------
  if (route === 'POST /upload') {
    const data = await body(req)
    return json(await startUpload({ dir: data.dir, relative: data.relative, size: data.size, conflict: data.conflict }))
  }
  const upload = path.match(/^\/upload\/([0-9a-f-]{36})(\/finish)?$/)
  if (upload) {
    const id = upload[1]!
    if (req.method === 'PUT' && !upload[2]) {
      return json(await receiveChunk(id, Number(query.get('offset')), await req.arrayBuffer()))
    }
    if (req.method === 'POST' && upload[2]) return json(await finishUpload(id))
    if (req.method === 'DELETE' && !upload[2]) {
      await cancelUpload(id)
      return json({ ok: true })
    }
  }

  // ---- Jobs, trash, accounts, favourites -------------------------------------
  if (route === 'GET /jobs') return json(listJobs())
  if (route === 'POST /jobs/clear') {
    clearFinished()
    return json(listJobs())
  }
  const jobCancel = path.match(/^\/jobs\/([0-9a-f-]{36})\/cancel$/)
  if (req.method === 'POST' && jobCancel) return json({ ok: cancelJob(jobCancel[1]!) })

  if (route === 'GET /trash') return json(trashList())
  if (route === 'POST /trash/restore') return json(await restoreItems(arrayOf((await body(req)).ids).map(String)))
  if (route === 'POST /trash/delete') return json(await purgeTrash(arrayOf((await body(req)).ids).map(String)))
  if (route === 'POST /trash/empty') return json(await purgeTrash('all'))

  if (route === 'GET /accounts') return json(await accounts())
  if (route === 'GET /favourites') return json(favourites())
  if (route === 'PUT /favourites') return json(setFavourites(arrayOf((await body(req)).paths)))

  if (route === 'GET /update') return json(updateState())
  if (route === 'POST /update/check') return json(await checkForUpdate())
  if (route === 'POST /update/apply') {
    const result = await applyUpdate()
    return json(result, result.ok ? 200 : 500)
  }
  if (route === 'POST /update/auto') {
    setAutoUpdate((await body(req)).enabled === true)
    return json(updateState())
  }

  if (route === 'GET /activity') {
    const rows = db
      .query('SELECT id, at, area, action, target, detail, ok, freed FROM activity ORDER BY id DESC LIMIT 300')
      .all()
    const total = db.query<{ freed: number | null }, []>('SELECT SUM(freed) AS freed FROM activity').get()
    return json({ rows, freed: total?.freed ?? 0 })
  }

  return fail('Not found.', 404)
}

async function asset(url: URL): Promise<Response> {
  const requested = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
  const file = join(config.webDir, requested)
  const inside = file.startsWith(config.webDir)
  const target = inside && requested !== '/' && (await Bun.file(file).exists()) ? file : join(config.webDir, 'index.html')
  const immutable = target.includes('/assets/')
  return new Response(Bun.file(target), {
    headers: { ...HEADERS, 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' },
  })
}

if (!existsSync(join(config.webDir, 'index.html'))) {
  console.error('The web interface has not been built yet. Run: bun run build')
  process.exit(1)
}

startTrashPurge()
startUploadCleanup()

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  // Measuring a large folder or searching the whole disk can take a while.
  idleTimeout: 240,
  // Uploads arrive in 8 MB parts; leave room for them.
  maxRequestBodySize: 64 * 1024 * 1024,
  async fetch(req, srv) {
    const url = new URL(req.url)
    try {
      if (url.pathname.startsWith('/api/')) {
        return await api(req, url, srv.requestIP(req)?.address ?? 'unknown')
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail('Not found.', 404)
      return await asset(url)
    } catch (error) {
      if (error instanceof FsError) return fail(error.message, error.status)
      if ((error as NodeJS.ErrnoException)?.code) return fail(explain(error), 400)
      console.error(error)
      return fail('Something went wrong on the server.', 500)
    }
  },
})

startUpdateChecks()

function publicUrl(): string {
  if (config.url) return config.url.replace(/\/+$/, '')
  let host = server.hostname ?? 'localhost'
  if (host === '0.0.0.0' || host === '::') {
    const addresses = Object.values(networkInterfaces()).flat()
    host = addresses.find((entry) => entry && entry.family === 'IPv4' && !entry.internal)?.address ?? 'localhost'
  }
  return `http://${host}:${server.port}`
}

console.log(`Classeur is listening on ${publicUrl()}`)

const firstRun = await ensureAdmin()
if (firstRun) {
  const text = [
    'Classeur is ready.',
    '',
    `Setup link:      ${publicUrl()}/setup?token=${firstRun.token}`,
    `Admin password:  ${firstRun.password}`,
    '',
    'Open the link once to choose your own password, or sign in with the one above.',
    '',
  ].join('\n')
  writeFileSync(setupFile, text, { mode: 0o600 })
  console.log(`\n${text}`)
}
if (process.getuid?.() !== 0) console.log('Not running as root: cleaning and service actions will be limited.')

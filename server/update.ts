import { existsSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { root } from './config.ts'
import { getSetting, logActivity, setSetting } from './db.ts'
import { listJobs } from './jobs.ts'
import { lines, readText, reason, run } from './sys.ts'

interface Commit {
  hash: string
  subject: string
  at: number
}

const BRANCH = 'main'
const web = join(root, 'web')
const managed = existsSync(join(root, '.git'))

let commits: Commit[] = []
let latestVersion: string | null = null
let checkedAt = Number(getSetting('update_checked_at')) || null
let checkError: string | null = null
let installing = false

const git = (args: string[], timeout = 60_000) => run(['git', '-C', root, ...args], { timeout })

function version(packageJson: string): string {
  try {
    return (JSON.parse(packageJson) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const currentVersion = version(readText(join(root, 'package.json')))
let currentCommit = ''
if (managed) currentCommit = (await git(['rev-parse', '--short', 'HEAD'])).stdout.trim()

export function updateState() {
  return {
    /** False when the app was not installed with git, so it cannot update itself. */
    managed,
    version: currentVersion,
    commit: currentCommit,
    latestVersion,
    available: commits.length > 0,
    commits,
    checkedAt,
    error: checkError,
    installing,
    auto: getSetting('auto_update') === '1',
  }
}

export function setAutoUpdate(enabled: boolean) {
  setSetting('auto_update', enabled ? '1' : '0')
}

export async function checkForUpdate() {
  if (!managed || installing) return updateState()

  const fetched = await git(['fetch', '--quiet', 'origin', BRANCH], 120_000)
  checkedAt = Date.now()
  setSetting('update_checked_at', String(checkedAt))
  if (!fetched.ok) {
    checkError = reason(fetched, 'The update server could not be reached.')
    return updateState()
  }
  checkError = null

  const log = await git(['log', '--format=%h%x09%ct%x09%s', `HEAD..origin/${BRANCH}`])
  commits = lines(log.stdout).map((line) => {
    const [hash = '', at = '0', ...subject] = line.split('\t')
    return { hash, at: Number(at) * 1000, subject: subject.join('\t') }
  })
  latestVersion = commits.length
    ? version((await git(['show', `origin/${BRANCH}:package.json`])).stdout)
    : currentVersion
  return updateState()
}

/**
 * Pulls the new code, builds the interface next to the live one and only then
 * swaps it in. If anything fails the code goes back to where it was, so a bad
 * update never leaves the panel broken.
 */
export async function applyUpdate(): Promise<{ ok: boolean; message: string }> {
  if (!managed) return { ok: false, message: 'This copy was not installed with git and cannot update itself.' }
  if (installing) return { ok: false, message: 'An update is already being installed.' }
  if (listJobs().some((job) => job.state === 'running')) {
    return { ok: false, message: 'A file operation is running. Try again when it has finished.' }
  }
  installing = true

  const before = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  const next = join(web, 'dist-next')
  const failed = async (message: string) => {
    await git(['reset', '--hard', before])
    rmSync(next, { recursive: true, force: true })
    logActivity({ area: 'update', action: 'Update failed', detail: message, ok: false })
    installing = false
    return { ok: false, message }
  }

  try {
    const pulled = await git(['pull', '--ff-only', 'origin', BRANCH], 180_000)
    if (!pulled.ok) return await failed(reason(pulled, 'The update could not be downloaded.'))

    const after = (await git(['rev-parse', 'HEAD'])).stdout.trim()
    if (after === before) {
      installing = false
      commits = []
      return { ok: true, message: 'Already up to date.' }
    }

    const bun = process.execPath
    const install = await run([bun, 'install', '--frozen-lockfile', '--cwd', web], { timeout: 300_000 })
    if (!install.ok) return await failed(reason(install, 'Dependencies could not be installed.'))

    const build = await run([bun, 'run', '--cwd', web, 'build', '--outDir', 'dist-next', '--emptyOutDir'], {
      timeout: 300_000,
    })
    if (!build.ok || !existsSync(join(next, 'index.html'))) {
      return await failed(reason(build, 'The interface could not be built.'))
    }

    const live = join(web, 'dist')
    const old = join(web, 'dist-old')
    rmSync(old, { recursive: true, force: true })
    if (existsSync(live)) renameSync(live, old)
    renameSync(next, live)
    rmSync(old, { recursive: true, force: true })

    const newVersion = version(readText(join(root, 'package.json')))
    logActivity({ area: 'update', action: 'Updated', target: `${currentVersion} → ${newVersion}` })

    // The service manager starts the new version as soon as this one exits.
    setTimeout(() => process.exit(0), 1_000)
    return { ok: true, message: 'Update installed. Restarting…' }
  } catch (error) {
    return await failed(error instanceof Error ? error.message : 'The update failed.')
  }
}

async function scheduled() {
  const state = await checkForUpdate()
  if (state.available && state.auto) await applyUpdate()
}

export function startUpdateChecks() {
  if (!managed) return
  setTimeout(() => void scheduled(), 30_000)
  setInterval(() => void scheduled(), 6 * 3_600_000)
}

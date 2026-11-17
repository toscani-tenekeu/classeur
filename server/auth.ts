import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.ts'
import { db, deleteSetting, getSetting, setSetting } from './db.ts'

const COOKIE = 'classeur_session'

export const setupFile = join(config.dataDir, 'first-run.txt')

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * First start: an admin password is generated and a one-time setup link is
 * printed. The link lets the owner choose their own password; the generated
 * one works as it is for anyone who would rather keep it.
 */
export async function ensureAdmin(): Promise<{ password: string; token: string } | null> {
  if (getSetting('password_hash') !== null) return null
  const password = randomBytes(12).toString('base64url')
  const token = randomBytes(24).toString('base64url')
  setSetting('password_hash', await Bun.password.hash(password))
  setSetting('setup_token', token)
  return { password, token }
}

export function setupPending(): boolean {
  return getSetting('setup_token') !== null
}

export function checkSetupToken(given: string): boolean {
  const token = getSetting('setup_token')
  if (!token) return false
  const expected = Buffer.from(token)
  const actual = Buffer.from(given)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export function finishSetup() {
  deleteSetting('setup_token')
  rmSync(setupFile, { force: true })
}

export async function setPassword(password: string) {
  setSetting('password_hash', await Bun.password.hash(password))
  finishSetup()
  db.query('DELETE FROM sessions').run()
}

export async function checkPassword(password: string): Promise<boolean> {
  const hash = getSetting('password_hash')
  if (!hash) return false
  return Bun.password.verify(password, hash)
}

export function createSession(): string {
  const token = randomBytes(32).toString('base64url')
  const now = Date.now()
  db.query('INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)').run(
    sha256(token),
    now,
    now + config.sessionDays * 86_400_000,
  )
  return token
}

function tokenFrom(req: Request): string | null {
  const header = req.headers.get('cookie') ?? ''
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === COOKIE) return rest.join('=')
  }
  return null
}

export function isAuthed(req: Request): boolean {
  const token = tokenFrom(req)
  if (!token) return false
  const row = db
    .query<{ expires_at: number }, [string]>('SELECT expires_at FROM sessions WHERE token_hash = ?')
    .get(sha256(token))
  return !!row && row.expires_at > Date.now()
}

export function endSession(req: Request) {
  const token = tokenFrom(req)
  if (token) db.query('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token))
}

export function sessionCookie(req: Request, token: string | null): string {
  const secure = req.headers.get('x-forwarded-proto') === 'https' ? '; Secure' : ''
  const age = token ? config.sessionDays * 86_400 : 0
  return `${COOKIE}=${token ?? ''}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure}`
}

/** Five tries a minute per address is plenty for a person and useless for guessing. */
const attempts = new Map<string, { count: number; resetAt: number }>()

export function allowAttempt(address: string): boolean {
  const now = Date.now()
  const entry = attempts.get(address)
  if (!entry || entry.resetAt < now) {
    attempts.set(address, { count: 1, resetAt: now + 60_000 })
    return true
  }
  entry.count += 1
  return entry.count <= 5
}

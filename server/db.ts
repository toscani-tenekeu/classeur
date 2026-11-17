import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { config } from './config.ts'

export const db = new Database(join(config.dataDir, 'classeur.sqlite'), { create: true, strict: true })

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS activity (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    at      INTEGER NOT NULL,
    area    TEXT NOT NULL,
    action  TEXT NOT NULL,
    target  TEXT NOT NULL DEFAULT '',
    detail  TEXT NOT NULL DEFAULT '',
    ok      INTEGER NOT NULL DEFAULT 1,
    freed   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS activity_at ON activity (at DESC);

  CREATE TABLE IF NOT EXISTS trash (
    id          TEXT PRIMARY KEY,
    original    TEXT NOT NULL,
    stored      TEXT NOT NULL,
    name        TEXT NOT NULL,
    directory   INTEGER NOT NULL,
    size        INTEGER NOT NULL,
    deleted_at  INTEGER NOT NULL
  );
`)

const getStmt = db.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
const setStmt = db.query(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
)

export function getSetting(key: string): string | null {
  return getStmt.get(key)?.value ?? null
}

export function setSetting(key: string, value: string) {
  setStmt.run(key, value)
}

export function deleteSetting(key: string) {
  db.query('DELETE FROM settings WHERE key = ?').run(key)
}

export interface ActivityEntry {
  area: 'files' | 'trash' | 'archive' | 'upload' | 'permissions' | 'editor' | 'account' | 'update'
  action: string
  target?: string
  detail?: string
  ok?: boolean
  /** Bytes freed, for permanent deletions. */
  freed?: number
}

const logStmt = db.query(
  'INSERT INTO activity (at, area, action, target, detail, ok, freed) VALUES (?, ?, ?, ?, ?, ?, ?)',
)

export function logActivity(entry: ActivityEntry) {
  logStmt.run(
    Date.now(),
    entry.area,
    entry.action,
    entry.target ?? '',
    (entry.detail ?? '').slice(0, 2000),
    entry.ok === false ? 0 : 1,
    Math.max(0, Math.round(entry.freed ?? 0)),
  )
}

export function prune() {
  const day = 86_400_000
  db.query('DELETE FROM activity WHERE at < ?').run(Date.now() - config.keepActivityDays * day)
  db.query('DELETE FROM sessions WHERE expires_at < ?').run(Date.now())
}

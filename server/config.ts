import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const root = resolve(import.meta.dir, '..')

export const config = {
  host: process.env.CLASSEUR_HOST ?? '127.0.0.1',
  port: Number(process.env.CLASSEUR_PORT ?? 7080),
  /** Public address, used only to print the setup link. */
  url: process.env.CLASSEUR_URL ?? '',
  dataDir: resolve(process.env.CLASSEUR_DATA ?? join(root, 'data')),
  webDir: join(root, 'web', 'dist'),
  sessionDays: 7,
  /** Items in the trash older than this are removed for good. */
  keepTrashDays: 30,
  /** Largest file the editor opens. */
  maxEditBytes: 5 * 1024 * 1024,
  keepActivityDays: 90,
}

mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })

export type Kind = 'file' | 'directory' | 'link' | 'other'

export interface Entry {
  name: string
  path: string
  kind: Kind
  target: string | null
  targetKind: Kind | null
  size: number
  modified: number
  mode: string
  owner: string
  group: string
  hidden: boolean
}

export interface Listing {
  path: string
  parent: string | null
  writable: boolean
  protected: string | null
  entries: Entry[]
}

export interface Details extends Entry {
  accessed: number
  changed: number
  created: number | null
  inode: number
  links: number
  uid: number
  gid: number
  writable: boolean
  removable: boolean
  sensitive: boolean
}

export interface TextFile {
  path: string
  content: string
  modified: number
  size: number
  writable: boolean
  protected: string | null
  sensitive: boolean
  extension: string
}

export interface SearchResult {
  path: string
  name: string
  kind: Kind
  size: number
  modified: number
  owner: string
}

export interface Search {
  path: string
  results: SearchResult[]
  truncated: boolean
  scanned: number
}

export interface Job {
  id: string
  kind: 'copy' | 'move' | 'delete' | 'compress' | 'extract' | 'fetch' | 'permissions'
  title: string
  state: 'running' | 'done' | 'failed' | 'cancelled'
  done: number
  total: number
  unit: 'bytes' | 'items'
  message: string | null
  errors: string[]
  startedAt: number
  finishedAt: number | null
  folders: string[]
}

export interface TrashItem {
  id: string
  original: string
  name: string
  directory: boolean
  size: number
  deletedAt: number
}

export interface ArchiveListing {
  path: string
  format: string
  count: number
  total: number
  truncated: boolean
  entries: { name: string; size: number; directory: boolean }[]
}

export interface Account {
  name: string
  id: number
}

export interface BatchResult {
  ok: boolean
  failed: { path: string; message: string }[]
}

export interface ActivityRow {
  id: number
  at: number
  area: string
  action: string
  target: string
  detail: string
  ok: number
  freed: number
}

export interface UpdateState {
  managed: boolean
  version: string
  commit: string
  latestVersion: string | null
  available: boolean
  commits: { hash: string; subject: string; at: number }[]
  checkedAt: number | null
  error: string | null
  installing: boolean
  auto: boolean
}

export interface ActionResult {
  ok: boolean
  message: string
}

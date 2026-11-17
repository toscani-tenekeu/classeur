import {
  FileArchiveIcon, FileAudioIcon, FileCodeIcon, FileIcon, FileImageIcon, FileLockIcon, FileTextIcon, FileVideoIcon,
  FolderIcon, FolderSymlinkIcon, LinkIcon,
} from '@lucide/vue'
import type { Component } from 'vue'
import type { Entry } from '@/lib/types'

export const parentOf = (path: string) => (path === '/' ? '/' : path.slice(0, path.lastIndexOf('/')) || '/')
export const nameOf = (path: string) => (path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1))
export const joinPath = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`)

export function extension(name: string): string {
  const lower = name.toLowerCase()
  for (const double of ['.tar.gz', '.tar.xz', '.tar.bz2', '.tar.zst']) if (lower.endsWith(double)) return double.slice(1)
  const dot = lower.lastIndexOf('.')
  return dot > 0 ? lower.slice(dot + 1) : ''
}

const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg']
const VIDEO = ['mp4', 'webm', 'ogv', 'mov', 'mkv']
const AUDIO = ['mp3', 'ogg', 'oga', 'wav', 'flac', 'aac', 'm4a', 'opus']
const ARCHIVE = ['zip', 'jar', 'war', 'tar', 'gz', 'tgz', 'xz', 'txz', 'bz2', 'tbz2', 'tar.gz', 'tar.xz', 'tar.bz2', 'tar.zst', 'tzst', '7z', 'rar']
const CODE = [
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'svelte', 'json', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env', 'sh', 'bash',
  'zsh', 'py', 'rb', 'php', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'sql', 'html', 'htm', 'css', 'scss', 'less',
  'xml', 'service', 'timer', 'socket', 'lua', 'pl', 'r', 'dart', 'swift', 'tf', 'hcl', 'graphql', 'proto',
]
const TEXT = ['txt', 'md', 'log', 'csv', 'tsv', 'rst', 'list', 'pem', 'crt', 'key', 'pub', 'lock']
/** Files with these names have no extension but are text. */
const TEXT_NAMES = /^(dockerfile|makefile|caddyfile|procfile|vagrantfile|jenkinsfile|gemfile|readme|license|changelog|authors|hosts|fstab|crontab|passwd|group|shadow|sudoers|hostname|resolv\.conf|\..+rc|\..+ignore|\.env.*|\.htaccess|\.editorconfig|authorized_keys|known_hosts|config)$/i

export type Opener = 'folder' | 'image' | 'video' | 'audio' | 'pdf' | 'archive' | 'text' | 'other'

export function openerFor(entry: Pick<Entry, 'name' | 'kind' | 'targetKind'>): Opener {
  const kind = entry.kind === 'link' ? entry.targetKind : entry.kind
  if (kind === 'directory') return 'folder'
  if (kind !== 'file') return 'other'
  const ext = extension(entry.name)
  if (IMAGE.includes(ext)) return 'image'
  if (VIDEO.includes(ext)) return 'video'
  if (AUDIO.includes(ext)) return 'audio'
  if (ext === 'pdf') return 'pdf'
  if (ARCHIVE.includes(ext)) return 'archive'
  if (CODE.includes(ext) || TEXT.includes(ext) || TEXT_NAMES.test(entry.name) || !ext) return 'text'
  return 'other'
}

export function iconFor(entry: Pick<Entry, 'name' | 'kind' | 'targetKind'>): Component {
  if (entry.kind === 'link') return entry.targetKind === 'directory' ? FolderSymlinkIcon : LinkIcon
  const opener = openerFor(entry)
  if (opener === 'folder') return FolderIcon
  if (opener === 'image') return FileImageIcon
  if (opener === 'video') return FileVideoIcon
  if (opener === 'audio') return FileAudioIcon
  if (opener === 'archive') return FileArchiveIcon
  const ext = extension(entry.name)
  if (['pem', 'key', 'crt', 'pub'].includes(ext) || /^(shadow|sudoers|authorized_keys)$/.test(entry.name)) return FileLockIcon
  if (CODE.includes(ext)) return FileCodeIcon
  if (opener === 'text') return FileTextIcon
  return FileIcon
}

export function typeLabel(entry: Pick<Entry, 'name' | 'kind' | 'targetKind'>): string {
  if (entry.kind === 'directory') return 'Folder'
  if (entry.kind === 'link') return entry.targetKind === 'directory' ? 'Link to folder' : entry.targetKind ? 'Link' : 'Broken link'
  if (entry.kind === 'other') return 'Special file'
  const ext = extension(entry.name)
  return ext ? `${ext.toUpperCase()} file` : 'File'
}

/** "0755" → "rwxr-xr-x" */
export function symbolic(mode: string): string {
  const digits = mode.slice(-3).split('').map(Number)
  return digits.map((digit) => `${digit & 4 ? 'r' : '-'}${digit & 2 ? 'w' : '-'}${digit & 1 ? 'x' : '-'}`).join('')
}

export const rawUrl = (path: string) => `/api/fs/raw?path=${encodeURIComponent(path)}`
export const downloadUrl = (path: string) => `/api/fs/download?path=${encodeURIComponent(path)}`
export const zipUrl = (paths: string[]) => `/api/fs/zip?${paths.map((path) => `path=${encodeURIComponent(path)}`).join('&')}`

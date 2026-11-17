import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, normalize, resolve } from 'node:path'
import { config, root } from './config.ts'

/** Turns any user-given value into a clean absolute path, or null. */
export function clean(input: unknown): string | null {
  if (typeof input !== 'string' || !input.startsWith('/') || input.includes('\0') || input.length > 4096) return null
  const path = normalize(input)
  return path.length > 1 ? path.replace(/\/+$/, '') : '/'
}

const within = (path: string, parent: string) =>
  parent === '/' || path === parent || path.startsWith(`${parent}/`)

/** Kernel views and device files: they can be looked at, never changed. */
const VIRTUAL = ['/proc', '/sys', '/dev', '/run']

/** The operating system itself. Changing anything here can stop the server from booting. */
const SYSTEM = ['/boot', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/usr', '/snap', '/efi']

/** Writable spots inside the system trees. */
const WRITABLE_INSIDE_SYSTEM = ['/usr/local', '/usr/share/nginx', '/usr/share/caddy']

/** Folders that may be filled and emptied, but never removed or renamed themselves. */
const KEEP = [
  '/home', '/root', '/etc', '/var', '/opt', '/srv', '/tmp', '/mnt', '/media', '/usr/local', '/lost+found',
  '/var/log', '/var/lib', '/var/cache', '/var/tmp', '/var/spool', '/var/www', '/var/backups', '/var/mail',
  '/var/lib/dpkg', '/var/lib/rpm', '/var/lib/pacman', '/var/lib/apk', '/var/lib/docker', '/var/lib/containerd',
  '/etc/ssh', '/etc/systemd', '/etc/sudoers.d', '/etc/nginx', '/etc/apache2', '/etc/httpd',
]

/** Files whose loss or a mistake in which can lock you out of the server. */
const SENSITIVE = [
  /^\/etc\/(passwd|shadow|group|gshadow|sudoers|fstab|crypttab|hosts|resolv\.conf|hostname|crontab|login\.defs)$/,
  /^\/etc\/sudoers\.d\//,
  /^\/etc\/ssh\/sshd_config(\.d\/.*)?$/,
  /^\/etc\/(network|netplan|NetworkManager|sysconfig\/network-scripts|systemd)\//,
  /^\/etc\/(pam\.d|security|selinux)\//,
  /^\/etc\/(default\/grub|mkinitcpio\.conf|dracut\.conf)$/,
  /^\/root\/\.ssh\//,
  /^\/home\/[^/]+\/\.ssh\//,
]

let own: string[] = []
function ownPaths(): string[] {
  if (!own.length) {
    own = [root, config.dataDir].map((path) => {
      try {
        return realpathSync(path)
      } catch {
        return resolve(path)
      }
    })
  }
  return own
}

let mountCache: { at: number; list: string[] } | null = null

/** Every mount point, read from the kernel. */
export function mountPoints(): string[] {
  if (mountCache && Date.now() - mountCache.at < 10_000) return mountCache.list
  let list: string[] = []
  try {
    list = readFileSync('/proc/self/mounts', 'utf8')
      .split('\n')
      .map((line) => line.split(' ')[1])
      .filter((value): value is string => Boolean(value))
      .map((value) => value.replace(/\\040/g, ' ').replace(/\\011/g, '\t').replace(/\\012/g, '\n').replace(/\\134/g, '\\'))
  } catch {
    // Without /proc the list stays empty and only the fixed rules apply.
  }
  mountCache = { at: Date.now(), list }
  return list
}

export type Access = 'write' | 'readonly'

/** Why a path cannot be changed, or null when it can. */
export function writeBlock(path: string): string | null {
  if (path.includes('/.classeur-trash')) return 'This is Classeur’s trash. Use the Trash page to restore or delete what is in it.'
  if (VIRTUAL.some((dir) => within(path, dir))) return 'This is a live view of the kernel or of devices. It cannot be changed here.'
  if (ownPaths().some((dir) => within(path, dir))) return 'Classeur’s own files cannot be changed from inside it.'
  if (WRITABLE_INSIDE_SYSTEM.some((dir) => within(path, dir) && path !== dir)) return null
  if (SYSTEM.some((dir) => within(path, dir))) return 'This belongs to the operating system. Changing it could stop the server from starting.'
  return null
}

/** Why a path cannot be deleted, moved or renamed itself, or null when it can. */
export function removeBlock(path: string): string | null {
  const blocked = writeBlock(path)
  if (blocked) return blocked
  if (path === '/' || path.split('/').length <= 2) return 'Top-level folders are needed by the system and cannot be removed.'
  if (KEEP.includes(path) || dirname(path) === '/home') return 'The system or a user needs this folder. Its contents can be changed, not the folder itself.'
  if (mountPoints().includes(path)) return 'A disk is mounted here. Unmount it before removing the folder.'
  if ([...ownPaths(), ...KEEP].some((dir) => within(dir, path))) return 'This folder holds something the system needs.'
  return null
}

/** True when a deletion would reach into another mounted disk. */
export function containsMount(path: string): boolean {
  return mountPoints().some((mount) => mount !== path && within(mount, path))
}

export function isSensitive(path: string): boolean {
  return SENSITIVE.some((pattern) => pattern.test(path))
}

export function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

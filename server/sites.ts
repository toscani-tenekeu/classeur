import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { has, lines, readText, run } from './sys.ts'

/** A folder a web server sends to visitors, and the address it is reached at. */
export interface WebRoot {
  server: 'nginx' | 'apache' | 'caddy'
  site: string
  scheme: 'http' | 'https'
  /** The folder as written in the configuration. */
  declared: string
  /** The same folder with links resolved. */
  dir: string
  /** The address the folder is reached at, such as / or /static. */
  mount: string
  logs: string[]
}

/** Releases of a site deployed side by side, with a link pointing at the one that is live. */
export interface ReleaseSet {
  site: string
  link: string
  dir: string
  current: string
  /** Every release folder other than the live one, newest first. */
  others: string[]
}

const within = (path: string, parent: string) => path === parent || path.startsWith(`${parent}/`)

function resolved(path: string): string | null {
  try {
    const real = realpathSync(path)
    return statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

interface Directive {
  name: string
  args: string[]
  block: Directive[] | null
}

/** Reads nginx configuration syntax: words, quoted strings, comments, `;` and blocks. */
function parseNginx(text: string): Directive[] {
  const tokens: string[] = []
  const pattern = /#[^\n]*|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([{};])|([^\s{};"'#]+)/g
  for (const match of text.matchAll(pattern)) {
    if (match[0].startsWith('#')) continue
    tokens.push(match[1] ?? match[2] ?? match[3] ?? match[4]!)
  }
  let index = 0
  function block(): Directive[] {
    const list: Directive[] = []
    let words: string[] = []
    while (index < tokens.length) {
      const token = tokens[index++]!
      if (token === ';') {
        if (words.length) list.push({ name: words[0]!, args: words.slice(1), block: null })
        words = []
      } else if (token === '{') {
        list.push({ name: words[0] ?? '', args: words.slice(1), block: block() })
        words = []
      } else if (token === '}') {
        return list
      } else {
        words.push(token)
      }
    }
    return list
  }
  return block()
}

function siteName(names: string[]): string {
  return names.find((name) => name !== '_' && name !== 'localhost' && !name.startsWith('~')) ?? 'Default site'
}

async function nginxRoots(): Promise<WebRoot[]> {
  if (!has('nginx')) return []
  const result = await run(['nginx', '-T'], { timeout: 20_000 })
  if (!result.stdout) return []
  const roots: WebRoot[] = []

  function servers(list: Directive[]) {
    for (const item of list) {
      if (item.name === 'server' && item.block) addServer(item.block)
      else if (item.block) servers(item.block)
    }
  }

  function addServer(block: Directive[]) {
    const names = block.filter((item) => item.name === 'server_name').flatMap((item) => item.args)
    const listens = block.filter((item) => item.name === 'listen').flatMap((item) => item.args)
    const scheme = listens.some((arg) => arg === 'ssl' || arg.endsWith('443')) ? 'https' : 'http'
    const logs = block
      .filter((item) => item.name === 'access_log' && item.args[0] && item.args[0] !== 'off')
      .map((item) => item.args[0]!)
    const base = { server: 'nginx' as const, site: siteName(names), scheme: scheme as 'http' | 'https', logs }

    const add = (declared: string, mount: string) => {
      if (!declared.startsWith('/') || declared.includes('$')) return
      const tidy = declared.replace(/\/+$/, '') || '/'
      const dir = resolved(tidy)
      if (dir && dir !== '/') roots.push({ ...base, declared: tidy, dir, mount })
    }
    // Locations that hand requests to a program instead of reading files from disk.
    const handsOff = (list: Directive[]) =>
      list.some((entry) => ['proxy_pass', 'return', 'fastcgi_pass', 'uwsgi_pass', 'grpc_pass'].includes(entry.name))

    const serverRoot = block.find((item) => item.name === 'root')?.args[0]
    const top = block.find((item) => item.name === 'location' && item.args.length === 1 && item.args[0] === '/')
    if (serverRoot && !(top?.block && handsOff(top.block))) add(serverRoot, '/')

    function locations(list: Directive[], inherited: string | undefined) {
      for (const item of list) {
        if (item.name !== 'location' || !item.block) continue
        const modifier = item.args.length > 1 ? item.args[0] : ''
        const path = item.args.at(-1) ?? '/'
        const root = item.block.find((entry) => entry.name === 'root')?.args[0]
        const alias = item.block.find((entry) => entry.name === 'alias')?.args[0]
        const regex = modifier === '~' || modifier === '~*'
        if (!handsOff(item.block) && path === '/' && !modifier) {
          if (root && root !== serverRoot) add(root, '/')
        } else if (!handsOff(item.block)) {
          // With root, the address is appended to the folder; only the part under the location is served.
          const served = root ?? (alias ? undefined : inherited)
          const folder = modifier === '=' ? dirname(path) : path
          if (served && !regex && served !== serverRoot) add(`${served.replace(/\/+$/, '')}${folder}`, folder)
          else if (root && regex) add(root, '/')
          if (alias && !regex) add(modifier === '=' ? dirname(alias) : alias, folder)
        }
        locations(item.block, root ?? inherited)
      }
    }
    locations(block, serverRoot)
  }

  servers(parseNginx(result.stdout))
  return roots
}

function apacheFiles(): string[] {
  const dirs = ['/etc/apache2/sites-enabled', '/etc/httpd/conf.d']
  const files = ['/etc/apache2/apache2.conf', '/etc/httpd/conf/httpd.conf']
  for (const dir of dirs) {
    try {
      for (const name of readdirSync(dir)) files.push(join(dir, name))
    } catch {
      // Not this distribution's layout.
    }
  }
  return files
}

function apacheRoots(): WebRoot[] {
  if (!has('apache2') && !has('httpd') && !has('apachectl')) return []
  const roots: WebRoot[] = []
  const unquote = (value: string) => value.replace(/^"|"$/g, '').replace(/\$\{APACHE_LOG_DIR\}/g, '/var/log/apache2')
  for (const file of apacheFiles()) {
    let host: { names: string[]; scheme: 'http' | 'https'; logs: string[]; dirs: [string, string][] } | null = null
    const flush = () => {
      if (!host) return
      for (const [declared, mount] of host.dirs) {
        const dir = resolved(declared)
        if (dir && dir !== '/') {
          roots.push({
            server: 'apache', site: siteName(host.names), scheme: host.scheme, declared, dir, mount, logs: host.logs,
          })
        }
      }
    }
    for (const line of lines(readText(file))) {
      if (line.startsWith('#')) continue
      const open = line.match(/^<VirtualHost\s+([^>]*)>/i)
      if (open) {
        host = { names: [], scheme: open[1]!.includes(':443') ? 'https' : 'http', logs: [], dirs: [] }
        continue
      }
      if (/^<\/VirtualHost>/i.test(line)) {
        flush()
        host = null
        continue
      }
      const [key, ...rest] = line.split(/\s+/)
      if (!host || !key) continue
      const name = key.toLowerCase()
      if (name === 'servername' || name === 'serveralias') host.names.push(...rest)
      else if (name === 'documentroot' && rest[0]) host.dirs.push([unquote(rest[0]), '/'])
      else if (name === 'alias' && rest[0] && rest[1]) host.dirs.push([unquote(rest[1]), rest[0]])
      else if (name === 'customlog' && rest[0] && unquote(rest[0]).startsWith('/')) host.logs.push(unquote(rest[0]))
    }
  }
  return roots
}

function caddyRoots(): WebRoot[] {
  const text = readText('/etc/caddy/Caddyfile')
  if (!text) return []
  const roots: WebRoot[] = []
  let depth = 0
  let names: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    if (depth === 0 && line.endsWith('{')) names = line.slice(0, -1).split(/[\s,]+/).filter(Boolean)
    const root = depth > 0 ? line.match(/^root\s+(?:\S+\s+)?(\/\S+)$/) : null
    if (root) {
      const dir = resolved(root[1]!)
      const site = siteName(names.map((name) => name.replace(/^https?:\/\//, '')))
      const scheme = names.some((name) => name.startsWith('http://') || name.startsWith(':')) ? 'http' : 'https'
      if (dir && dir !== '/') roots.push({ server: 'caddy', site, scheme, declared: root[1]!, dir, mount: '/', logs: [] })
    }
    depth += (line.match(/{/g)?.length ?? 0) - (line.match(/}/g)?.length ?? 0)
  }
  return roots
}

let cached: { at: number; roots: WebRoot[] } | null = null

/** Every folder that nginx, Apache or Caddy serves, read from their configuration. */
export async function webRoots(): Promise<WebRoot[]> {
  if (cached && Date.now() - cached.at < 60_000) return cached.roots
  const all = [...(await nginxRoots()), ...apacheRoots(), ...caddyRoots()]
  const seen = new Set<string>()
  const roots = all.filter((root) => {
    const key = `${root.site}|${root.dir}|${root.mount}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  cached = { at: Date.now(), roots }
  return roots
}

/** The web root that serves a file, preferring the most specific one. */
export function rootServing(roots: WebRoot[], file: string): WebRoot | null {
  return roots.filter((root) => within(file, root.dir)).sort((a, b) => b.dir.length - a.dir.length)[0] ?? null
}

/** The address a file under a web root is reached at. */
export function addressOf(root: WebRoot, file: string): { url: string; path: string } {
  const rest = file.slice(root.dir.length).split('/').map(encodeURIComponent).join('/')
  const path = `${root.mount.replace(/\/+$/, '')}${rest}` || '/'
  return { url: `${root.scheme}://${root.site}${path}`, path }
}

const RELEASE_DIR = /^(releases?|versions?|builds?|deploys?|deployments?)$/i

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Sites deployed as releases side by side (releases/<id>, with a "current" link to one of them).
 * Found by following the links in each web root's path.
 */
export function releaseSets(roots: WebRoot[]): ReleaseSet[] {
  const sets = new Map<string, ReleaseSet>()
  for (const root of roots) {
    const parts = root.declared.split('/').filter(Boolean)
    for (let index = 1; index <= parts.length; index += 1) {
      const link = `/${parts.slice(0, index).join('/')}`
      let target: string
      try {
        if (!lstatSync(link).isSymbolicLink()) continue
        target = realpathSync(link)
      } catch {
        break
      }
      const dir = dirname(target)
      if (dir === '/' || sets.has(dir)) break
      if (!RELEASE_DIR.test(basename(dir)) && dirname(dir) !== dirname(link)) break
      let others: string[]
      try {
        others = readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && join(dir, entry.name) !== target)
          .map((entry) => join(dir, entry.name))
      } catch {
        break
      }
      if (!others.length) break
      others.sort((a, b) => mtime(b) - mtime(a))
      sets.set(dir, { site: root.site, link, dir, current: target, others })
      break
    }
  }
  return [...sets.values()]
}

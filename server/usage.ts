import { createReadStream, existsSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { pacer } from './jobs.ts'
import { addressOf, releaseSets, rootServing, type ReleaseSet, type WebRoot, webRoots } from './sites.ts'
import { run as exec } from './sys.ts'

export type Use = 'used' | 'maybe' | 'unused'

export interface Reference {
  file: string
  line: number
}

export interface FileUse {
  path: string
  use: Use
  /** A few words for the list. */
  label: string
  /** Why Balai thinks so, one sentence each. */
  reasons: string[]
  site: { name: string; url: string } | null
  release: { site: string; current: string; previous: boolean } | null
  project: { root: string; git: 'tracked' | 'untracked' | 'ignored' | null } | null
  references: Reference[]
  referenceCount: number
  requests: { count: number; last: number | null; since: number | null } | null
  openBy: string[]
  copyOf: string | null
}

/** What the check needs from whoever runs it: a way to stop, and somewhere to say what it is doing. */
interface Handle {
  signal: AbortSignal
  check(): void
}

const within = (path: string, parent: string) => path === parent || path.startsWith(`${parent}/`)

/** Text files that can name other files: pages, styles, scripts, templates and settings. */
const TEXT = new Set([
  'html', 'htm', 'xhtml', 'css', 'scss', 'sass', 'less', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'vue', 'svelte',
  'astro', 'php', 'phtml', 'twig', 'blade', 'md', 'mdx', 'json', 'yml', 'yaml', 'xml', 'svg', 'txt', 'py', 'rb', 'erb',
  'go', 'rs', 'java', 'kt', 'cs', 'liquid', 'hbs', 'ejs', 'pug', 'njk', 'webmanifest', 'toml', 'ini', 'conf', 'map',
])

/** Folders of installed dependencies, caches and version control, never read for links. */
const SKIP_DIRS = new Set([
  '.git', '.svn', '.hg', 'node_modules', 'bower_components', 'vendor', '.cache', '__pycache__', '.venv', 'venv',
  '.tox', '.turbo', '.parcel-cache', 'coverage', '.pnpm-store', '.yarn', '.next', '.nuxt', '.svelte-kit', '.output',
  '.angular', '.gradle', 'target',
])

/** Folders whose files are installed or built by tools rather than written by people. */
const GENERATED = /\/(node_modules|bower_components|vendor|\.next|\.nuxt|\.svelte-kit|\.cache|__pycache__|\.venv|venv|target|\.gradle)\//

const PROJECT_MARKERS = ['.git', 'package.json', 'composer.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'Gemfile']

const MAX_TEXT = 2 * 1024 ** 2
const READ_BUDGET = 400 * 1024 ** 2
const FILES_PER_SCOPE = 60_000

const extension = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Programs that have each file open right now. */
async function openFiles(targets: Set<string>, pace: () => Promise<void>): Promise<Map<string, Set<string>>> {
  const found = new Map<string, Set<string>>()
  let pids: string[] = []
  try {
    pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name))
  } catch {
    return found
  }
  for (const pid of pids) {
    await pace()
    let fds: string[]
    try {
      fds = readdirSync(`/proc/${pid}/fd`)
    } catch {
      continue
    }
    for (const fd of fds) {
      let target: string
      try {
        target = readlinkSync(`/proc/${pid}/fd/${fd}`)
      } catch {
        continue
      }
      if (!targets.has(target)) continue
      let name = pid
      try {
        name = readFileSync(`/proc/${pid}/comm`, 'utf8').trim() || pid
      } catch {
        // The program exited.
      }
      if (!found.has(target)) found.set(target, new Set())
      found.get(target)!.add(name)
    }
  }
  return found
}

/** The nearest folder above a file that looks like the top of a project. */
function projectOf(file: string, cache: Map<string, string | null>): string | null {
  const visited: string[] = []
  let dir = dirname(file)
  let found: string | null = null
  while (dir !== '/' && dir !== '') {
    if (cache.has(dir)) {
      found = cache.get(dir)!
      break
    }
    visited.push(dir)
    // A git folder wins over markers further down, such as a package.json in a sub-package.
    if (existsSync(join(dir, '.git'))) {
      found = dir
      break
    }
    dir = dirname(dir)
  }
  if (!found) {
    // No git repository: the nearest folder with a project file.
    for (const candidate of visited) {
      if (PROJECT_MARKERS.some((marker) => existsSync(join(candidate, marker)))) {
        found = candidate
        break
      }
    }
  }
  for (const item of visited) cache.set(item, found)
  return found
}

async function gitStates(root: string, files: string[]): Promise<Map<string, 'tracked' | 'untracked' | 'ignored'>> {
  const states = new Map<string, 'tracked' | 'untracked' | 'ignored'>()
  if (!existsSync(join(root, '.git'))) return states
  const git = ['git', '-c', 'safe.directory=*', '-C', root]
  const relative = files.map((file) => file.slice(root.length + 1))
  const tracked = await exec([...git, 'ls-files', '-z', '--', ...relative.slice(0, 2000)], { timeout: 60_000 })
  if (!tracked.ok) return states
  const trackedSet = new Set(tracked.stdout.split('\0').filter(Boolean))
  const rest = relative.filter((file) => !trackedSet.has(file))
  const ignored = rest.length
    ? await exec([...git, 'check-ignore', '-z', '--stdin'], { timeout: 60_000, input: `${rest.join('\0')}\0` })
    : null
  const ignoredSet = new Set((ignored?.stdout ?? '').split('\0').filter(Boolean))
  for (const [index, file] of files.entries()) {
    const name = relative[index]!
    states.set(file, trackedSet.has(name) ? 'tracked' : ignoredSet.has(name) ? 'ignored' : 'untracked')
  }
  return states
}

interface ScopeScan {
  references: Map<string, Reference[]>
  /** Every file under the scope whose name is one being checked, for spotting copies. */
  named: Map<string, string[]>
  complete: boolean
}

/** Characters that end a file name inside code or markup. */
const SEPARATOR = new Set([...' \t\n\r"\'`()<>[]{},;=\\|*?#&/:'])

/**
 * File names in a text that end with one of the extensions. Each ".ext" is found first and the name is read
 * backwards from it, which stays fast on minified files with very long lines.
 */
function* namesIn(text: string, pattern: RegExp): Generator<{ name: string; index: number }> {
  pattern.lastIndex = 0
  for (const match of text.matchAll(pattern)) {
    const end = (match.index ?? 0) + match[0].length
    let start = match.index ?? 0
    while (start > 0 && end - start < 256 && !SEPARATOR.has(text[start - 1]!)) start -= 1
    if (start === match.index) continue
    yield { name: safeDecode(text.slice(start, end)), index: start }
  }
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Reads the text files under a folder and notes every place that names one of the files being checked.
 * Matching is by file name: "logo.png" in a page counts for every logo.png in that folder.
 */
async function scanScope(
  dir: string,
  names: Set<string>,
  handle: Handle,
  budget: { left: number },
  skipDependencies: boolean,
): Promise<ScopeScan> {
  const references = new Map<string, Reference[]>()
  const named = new Map<string, string[]>()
  // Names with spaces or other separators cannot be found as tokens, so they are looked up directly.
  const awkward = [...names].filter((name) => [...name].some((char) => SEPARATOR.has(char)))
  const extensions = [...new Set([...names].map(extension).filter(Boolean))]
  const pattern = new RegExp(`\\.(?:${extensions.map(escape).join('|') || 'x^'})(?![A-Za-z0-9])`, 'gi')
  let seen = 0
  let complete = true
  const stack = [dir]
  const pace = pacer(handle.signal)

  while (stack.length) {
    await pace()
    const current = stack.pop()!
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '.git' || (skipDependencies && SKIP_DIRS.has(entry.name))) continue
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      if (++seen > FILES_PER_SCOPE) {
        complete = false
        stack.length = 0
        break
      }
      if (names.has(entry.name)) {
        if (!named.has(entry.name)) named.set(entry.name, [])
        named.get(entry.name)!.push(full)
      }
      if (!TEXT.has(extension(entry.name))) continue
      await pace()
      let text: string
      try {
        const size = statSync(full).size
        if (size > MAX_TEXT || size > budget.left) {
          if (size > budget.left) complete = false
          continue
        }
        budget.left -= size
        text = readFileSync(full, 'utf8')
      } catch {
        continue
      }
      const note = (name: string, index: number) => {
        if (!references.has(name)) references.set(name, [])
        const list = references.get(name)!
        if (list.some((item) => item.file === full) && list.length >= 50) return
        let line = 1
        for (let position = text.indexOf('\n'); position !== -1 && position < index; position = text.indexOf('\n', position + 1)) line += 1
        list.push({ file: full, line })
      }
      for (const found of namesIn(text, pattern)) {
        if (names.has(found.name) && found.name !== entry.name) note(found.name, found.index)
      }
      for (const name of awkward) {
        if (name === entry.name) continue
        for (const form of new Set([name, encodeURI(name), name.replace(/ /g, '+')])) {
          const index = text.indexOf(form)
          if (index !== -1) {
            note(name, index)
            break
          }
        }
      }
    }
  }
  return { references, named, complete }
}

interface LogHits {
  hits: Map<string, { count: number; last: number }>
  since: number | null
  lines: number
}

const LOG_LINE = /\[(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})\] "(?:GET|HEAD) ([^ ?"]+)[^"]*" (\d{3})/
const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
}

function logTime(match: RegExpMatchArray): number {
  const zone = match[7]!
  const offset = (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3))) * (zone.startsWith('-') ? -1 : 1)
  return Date.UTC(Number(match[3]), MONTHS[match[2]!] ?? 0, Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6])) - offset * 60_000
}

/** Counts successful requests for each address in a site's access logs, the current file and a few rotated ones. */
async function readLogs(logs: string[], wanted: Set<string>, handle: Handle): Promise<LogHits> {
  const result: LogHits = { hits: new Map(), since: null, lines: 0 }
  const files = logs.flatMap((log) => [log, `${log}.1`, `${log}.2.gz`, `${log}.3.gz`, `${log}.4.gz`]).filter((file) => existsSync(file))
  for (const file of files) {
    handle.check()
    let text: string
    try {
      const size = statSync(file).size
      if (!size || size > 200 * 1024 ** 2) continue
      text = file.endsWith('.gz') ? gunzipSync(readFileSync(file)).toString('utf8') : readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const pace = pacer(handle.signal)
    for (const line of text.split('\n')) {
      await pace()
      const match = line.match(LOG_LINE)
      if (!match) continue
      result.lines += 1
      const at = logTime(match)
      if (result.since === null || at < result.since) result.since = at
      const status = Number(match[9])
      if (status >= 400) continue
      const path = safeDecode(match[8]!)
      if (!wanted.has(path)) continue
      const entry = result.hits.get(path) ?? { count: 0, last: 0 }
      entry.count += 1
      entry.last = Math.max(entry.last, at)
      result.hits.set(path, entry)
    }
  }
  return result
}

async function hashOf(file: string): Promise<string | null> {
  try {
    if (statSync(file).size > 512 * 1024 ** 2) return null
    const hasher = new Bun.CryptoHasher('sha1')
    for await (const chunk of createReadStream(file)) hasher.update(chunk as Buffer)
    return hasher.digest('hex')
  } catch {
    return null
  }
}

/** True when a site builds its pages from code, where links can live in a database. */
function dynamicSite(root: WebRoot): boolean {
  try {
    return readdirSync(root.dir).some((name) => name.endsWith('.php')) || /\/uploads?(\/|$)/.test(root.dir)
  } catch {
    return false
  }
}

const run = <T>(work: () => Promise<T>) => work()

/** Works out, for each file, whether a website, a project or a program uses it. */
export async function checkUsage(paths: string[], signal: AbortSignal): Promise<FileUse[]> {
  const handle: Handle = {
    signal,
    check() {
      if (signal.aborted) throw new Error('Cancelled.')
    },
  }
  const files = [...new Set(paths)]

  const { roots, releases } = await run(async () => {
    const roots = await webRoots()
    return { roots, releases: releaseSets(roots) }
  })

  const open = await run(() => openFiles(new Set(files), pacer(handle.signal)))

  const projects = new Map<string, string[]>()
  const projectFor = new Map<string, string>()
  const states = new Map<string, 'tracked' | 'untracked' | 'ignored'>()
  await run(async () => {
    const cache = new Map<string, string | null>()
    for (const file of files) {
      // Files of a live site or an old release are judged by the site, not by a project around it.
      if (rootServing(roots, file) || releaseOf(releases, file)) continue
      const root = projectOf(file, cache)
      if (!root) continue
      projectFor.set(file, root)
      if (!projects.has(root)) projects.set(root, [])
      projects.get(root)!.push(file)
    }
    for (const [root, list] of projects) {
      handle.check()
      for (const [file, state] of await gitStates(root, list)) states.set(file, state)
    }
  })

  // Each website folder and each project is read once, for all the names that matter in it.
  const scopes = new Map<string, { names: Set<string>; site: boolean }>()
  const addScope = (dir: string, name: string, site: boolean) => {
    if (!scopes.has(dir)) scopes.set(dir, { names: new Set(), site })
    scopes.get(dir)!.names.add(name)
  }
  const allNames = new Set(files.map((file) => basename(file)))
  for (const file of files) {
    const root = rootServing(roots, file)
    if (root) addScope(root.dir, basename(file), true)
    const project = projectFor.get(file)
    if (project) addScope(project, basename(file), false)
  }
  // Every live site is read too, to recognise copies of its files anywhere else.
  for (const root of roots) for (const name of allNames) addScope(root.dir, name, true)

  const scans = new Map<string, ScopeScan>()
  await run(async () => {
    const budget = { left: READ_BUDGET }
    const ordered = [...scopes.entries()].sort((a, b) => a[0].length - b[0].length)
    // A folder inside another of the same kind is covered when the outer one is read.
    for (const [dir, scope] of ordered) {
      const outer = ordered.find(([other, item]) => other !== dir && within(dir, other) && item.site === scope.site)
      if (outer) for (const name of scope.names) outer[1].names.add(name)
    }
    for (const [dir, { names, site }] of ordered) {
      // A folder inside one already read shares its results.
      const parent = [...scans.keys()].find((done) => within(dir, done) && scopes.get(done)!.site === site)
      scans.set(dir, parent ? scans.get(parent)! : await scanScope(dir, names, handle, budget, !site))
    }
  })

  // Requests per address, from each site's access logs.
  const hitsBySite = new Map<string, LogHits>()
  await run(async () => {
    const wanted = new Map<string, Set<string>>()
    for (const file of files) {
      const root = rootServing(roots, file)
      if (!root?.logs.length) continue
      const key = root.logs.join('|')
      if (!wanted.has(key)) wanted.set(key, new Set())
      wanted.get(key)!.add(safeDecode(addressOf(root, file).path))
    }
    for (const [key, paths] of wanted) hitsBySite.set(key, await readLogs(key.split('|'), paths, handle))
  })

  // Copies of live files: same name and same content as a file a site serves.
  const copies = new Map<string, string>()
  await run(async () => {
    const hashes = new Map<string, string | null>()
    const hash = async (file: string) => {
      if (!hashes.has(file)) hashes.set(file, await hashOf(file))
      return hashes.get(file)!
    }
    for (const file of files) {
      handle.check()
      if (rootServing(roots, file)) continue
      const name = basename(file)
      let size: number
      try {
        size = statSync(file).size
      } catch {
        continue
      }
      for (const root of roots) {
        const twins = scans.get(root.dir)?.named.get(name) ?? []
        for (const twin of twins) {
          if (twin === file) continue
          try {
            if (statSync(twin).size !== size) continue
          } catch {
            continue
          }
          const [mine, theirs] = await Promise.all([hash(file), hash(twin)])
          if (mine && mine === theirs) {
            copies.set(file, twin)
            break
          }
        }
        if (copies.has(file)) break
      }
    }
  })

  return files.map((file) => {
    const name = basename(file)
    const root = rootServing(roots, file)
    const release = releaseOf(releases, file)
    const projectRoot = projectFor.get(file) ?? null
    const git = states.get(file) ?? null
    const openBy = [...(open.get(file) ?? [])]

    let references: Reference[] = []
    let complete = true
    const scopeDir = root?.dir ?? projectRoot
    if (scopeDir) {
      const scan = scans.get(scopeDir)
      references = scan?.references.get(name) ?? []
      complete = scan?.complete ?? true
    }

    const reasons: string[] = []
    let use: Use = 'unused'
    let label = 'No use found'
    let site: FileUse['site'] = null
    let requests: FileUse['requests'] = null

    if (root) {
      const address = addressOf(root, file)
      site = { name: root.site, url: address.url }
      reasons.push(`${root.site} serves it at ${address.path}.`)
      const logs = root.logs.length ? hitsBySite.get(root.logs.join('|')) : undefined
      if (logs?.lines) {
        const hit = logs.hits.get(safeDecode(address.path))
        requests = { count: hit?.count ?? 0, last: hit?.last ?? null, since: logs.since }
        reasons.push(hit ? `Requested ${hit.count} times in the access log.` : 'Never requested in the access log.')
      } else if (root.logs.length) {
        reasons.push('The access log is empty, so visits cannot be counted.')
      }
      if (references.length || requests?.count) {
        use = 'used'
        label = `Live on ${root.site}`
        if (references.length) reasons.push(`${references.length === 1 ? 'One file' : `${references.length} files`} of the site refer to it.`)
      } else {
        use = 'maybe'
        label = 'Live, not linked'
        reasons.push('No page, style or script of the site refers to it. Other sites or bookmarks may still link to it.')
        if (dynamicSite(root)) reasons.push('This site builds pages with code: links stored in a database are not seen.')
      }
    } else if (release) {
      label = release.previous ? 'Previous release' : 'Old release'
      reasons.push(`It belongs to an old release of ${release.site}; the site serves ${release.current}.`)
      if (release.previous) reasons.push('This is the release before the live one, kept for going back.')
    } else if (projectRoot) {
      const generated = GENERATED.test(file.slice(projectRoot.length))
      if (git === 'tracked') reasons.push(`Kept in git in ${projectRoot}, so deleting it here leaves it in the project's history.`)
      else if (git === 'ignored') reasons.push(`In ${projectRoot}, ignored by git: usually something built or downloaded.`)
      else if (git === 'untracked') reasons.push(`In ${projectRoot}, but never committed to git.`)
      else reasons.push(`In the project ${projectRoot}.`)
      if (generated) {
        use = 'maybe'
        label = 'Dependency or build file'
        reasons.push('Installed or built by a tool. Reinstalling or rebuilding brings it back, but the project may need it now.')
      } else if (references.length) {
        use = 'used'
        label = 'Used in project'
        reasons.push(`${references.length === 1 ? 'One file' : `${references.length} files`} of the project refer to it.`)
      } else if (git === 'tracked') {
        use = 'maybe'
        label = 'In git, not linked'
        reasons.push('No file of the project refers to it.')
      } else {
        label = 'Not linked in project'
        reasons.push('No file of the project refers to it.')
      }
    } else {
      reasons.push('It is not inside a website folder or a project.')
    }

    const copyOf = copies.get(file) ?? null
    if (copyOf) {
      reasons.push(`Same content as ${copyOf}, which is live.`)
      if (use === 'unused' && !release) label = 'Copy of a live file'
    }
    if (openBy.length) {
      use = 'used'
      label = 'Open now'
      reasons.unshift(`Open right now in ${openBy.join(', ')}.`)
    }
    if (!complete) reasons.push('The folder was too large to read completely, so some links may have been missed.')

    return {
      path: file,
      use,
      label,
      reasons,
      site,
      release,
      project: projectRoot ? { root: projectRoot, git } : null,
      references: references.slice(0, 20),
      referenceCount: references.length,
      requests,
      openBy,
      copyOf,
    }
  })
}

function releaseOf(sets: ReleaseSet[], file: string): FileUse['release'] {
  for (const set of sets) {
    const other = set.others.find((dir) => within(file, dir))
    if (other) return { site: set.site, current: set.current, previous: other === set.others[0] }
  }
  return null
}

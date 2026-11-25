import { readFileSync } from 'node:fs'
import { Cancelled, scope } from './jobs.ts'

export interface RunResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
}

const SETSID = Bun.which('setsid')

export interface SpawnOptions {
  timeout?: number
  env?: Record<string, string>
  cwd?: string
  stdout?: 'pipe' | 'ignore'
  input?: string
}

/**
 * Starts a program in its own process group. When the task or request it runs for is cancelled,
 * or the time limit passes, the whole group is killed at once, children of a shell included.
 */
export function spawn(cmd: string[], opts: SpawnOptions = {}) {
  const signal = scope.getStore()?.signal
  if (signal?.aborted) throw new Cancelled()
  const proc = Bun.spawn(SETSID ? [SETSID, ...cmd] : cmd, {
    cwd: opts.cwd,
    stdin: opts.input === undefined ? 'ignore' : new Blob([opts.input]),
    stdout: opts.stdout ?? 'pipe',
    stderr: 'pipe',
    env: { ...process.env, LC_ALL: 'C', LANG: 'C', ...opts.env },
  })
  const kill = () => {
    try {
      // setsid makes the program the leader of a new group whose id is its pid.
      if (SETSID) process.kill(-proc.pid, 'SIGKILL')
      else proc.kill('SIGKILL')
    } catch {
      // Already gone.
    }
  }
  const timer = opts.timeout === 0 ? undefined : setTimeout(kill, opts.timeout ?? 15_000)
  signal?.addEventListener('abort', kill, { once: true })
  void proc.exited.finally(() => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', kill)
  })
  return proc
}

/**
 * Runs a program with an explicit argument list. Nothing goes through a shell,
 * so values taken from a request can never be interpreted as shell syntax.
 */
export async function run(cmd: string[], opts: SpawnOptions = {}): Promise<RunResult> {
  try {
    const proc = spawn(cmd, opts)
    const [stdout, stderr, code] = await Promise.all([
      proc.stdout ? new Response(proc.stdout as ReadableStream).text() : Promise.resolve(''),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { ok: code === 0, code, stdout, stderr }
  } catch (error) {
    if (error instanceof Cancelled) throw error
    return { ok: false, code: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
  }
}

export function has(program: string): boolean {
  return Bun.which(program) !== null
}

export function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

export function lines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean)
}

/** Last meaningful line of a command's error output, for showing to the user. */
export function reason(result: RunResult, fallback: string): string {
  const all = lines(result.stderr).concat(lines(result.stdout))
  return all.at(-1) ?? fallback
}

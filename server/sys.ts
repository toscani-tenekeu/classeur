import { readFileSync } from 'node:fs'

export interface RunResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
}

/**
 * Runs a program with an explicit argument list. Nothing goes through a shell,
 * so values taken from a request can never be interpreted as shell syntax.
 */
export async function run(
  cmd: string[],
  opts: { timeout?: number; env?: Record<string, string> } = {},
): Promise<RunResult> {
  try {
    const proc = Bun.spawn(cmd, {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: opts.timeout ?? 15_000,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', ...opts.env },
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { ok: code === 0, code, stdout, stderr }
  } catch (error) {
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

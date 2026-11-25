import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

export type JobState = 'running' | 'done' | 'failed' | 'cancelled'

export interface Job {
  id: string
  kind: 'copy' | 'move' | 'delete' | 'compress' | 'extract' | 'fetch' | 'permissions'
  title: string
  state: JobState
  /** Bytes or items done so far, out of total; total 0 means unknown. */
  done: number
  total: number
  unit: 'bytes' | 'items'
  /** The file or step being worked on right now. */
  now: string | null
  message: string | null
  errors: string[]
  startedAt: number
  finishedAt: number | null
  /** Folder to refresh in the interface when the job ends. */
  folders: string[]
}

interface Control {
  job: Job
  controller: AbortController
  onCancel: (() => void)[]
}

/** The job, or request, the current code runs for. Programs started from it stop when it is cancelled. */
export interface Scope {
  signal: AbortSignal
}

export const scope = new AsyncLocalStorage<Scope>()

const jobs = new Map<string, Control>()

export class Cancelled extends Error {
  constructor() {
    super('Cancelled.')
  }
}

export interface Handle {
  job: Job
  signal: AbortSignal
  readonly cancelled: boolean
  onCancel(handler: () => void): void
  check(): void
}

/**
 * Runs long work in the background. The interface follows its progress and can cancel it;
 * the request that started it returns at once. Cancelling marks the job cancelled straight away
 * and kills every program it started, so nobody waits for the work to notice.
 */
export function startJob(
  init: Pick<Job, 'kind' | 'title' | 'unit' | 'folders'> & { total?: number },
  work: (handle: Handle) => Promise<string | void>,
): Job {
  const job: Job = {
    id: randomUUID(),
    kind: init.kind,
    title: init.title,
    state: 'running',
    done: 0,
    total: init.total ?? 0,
    unit: init.unit,
    now: null,
    message: null,
    errors: [],
    startedAt: Date.now(),
    finishedAt: null,
    folders: init.folders,
  }
  const control: Control = { job, controller: new AbortController(), onCancel: [] }
  jobs.set(job.id, control)
  const signal = control.controller.signal

  const handle: Handle = {
    job,
    signal,
    get cancelled() {
      return signal.aborted
    },
    onCancel: (handler) => control.onCancel.push(handler),
    check: () => {
      if (signal.aborted) throw new Cancelled()
    },
  }

  void scope.run({ signal }, async () => {
    try {
      const message = await work(handle)
      if (signal.aborted) return
      job.state = job.errors.length ? 'failed' : 'done'
      job.message = message ?? null
    } catch (error) {
      if (signal.aborted) return
      job.state = 'failed'
      job.message = error instanceof Error ? error.message : String(error)
    }
    job.now = null
    job.finishedAt = Date.now()
  })

  return job
}

export function listJobs(): Job[] {
  const now = Date.now()
  for (const [id, control] of jobs) {
    // Finished jobs stay visible for an hour.
    if (control.job.finishedAt && now - control.job.finishedAt > 3_600_000) jobs.delete(id)
  }
  return [...jobs.values()].map((control) => control.job).sort((a, b) => b.startedAt - a.startedAt)
}

export function cancelJob(id: string): boolean {
  const control = jobs.get(id)
  if (!control || control.job.state !== 'running') return false
  const { job } = control
  job.state = 'cancelled'
  job.message = 'Cancelled.'
  job.now = null
  job.finishedAt = Date.now()
  control.controller.abort()
  for (const handler of control.onCancel) {
    try {
      handler()
    } catch {
      // Already stopped.
    }
  }
  return true
}

/** Long loops in the server's own code await this often: it lets other requests in and stops a cancelled job. */
export function pacer(signal: AbortSignal) {
  let last = Date.now()
  return async () => {
    if (signal.aborted) throw new Cancelled()
    if (Date.now() - last < 25) return
    await Bun.sleep(0)
    last = Date.now()
    if (signal.aborted) throw new Cancelled()
  }
}

export function clearFinished() {
  for (const [id, control] of jobs) if (control.job.state !== 'running') jobs.delete(id)
}

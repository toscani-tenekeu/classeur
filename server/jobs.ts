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
  message: string | null
  errors: string[]
  startedAt: number
  finishedAt: number | null
  /** Folder to refresh in the interface when the job ends. */
  folders: string[]
}

interface Control {
  job: Job
  cancelled: boolean
  onCancel: (() => void)[]
}

const jobs = new Map<string, Control>()

export class Cancelled extends Error {
  constructor() {
    super('Cancelled.')
  }
}

export interface Handle {
  job: Job
  readonly cancelled: boolean
  onCancel(handler: () => void): void
  check(): void
}

/**
 * Runs long work in the background. The interface follows its progress and
 * can cancel it; the request that started it returns at once.
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
    message: null,
    errors: [],
    startedAt: Date.now(),
    finishedAt: null,
    folders: init.folders,
  }
  const control: Control = { job, cancelled: false, onCancel: [] }
  jobs.set(job.id, control)

  const handle: Handle = {
    job,
    get cancelled() {
      return control.cancelled
    },
    onCancel: (handler) => control.onCancel.push(handler),
    check: () => {
      if (control.cancelled) throw new Cancelled()
    },
  }

  void (async () => {
    try {
      const message = await work(handle)
      job.state = control.cancelled ? 'cancelled' : job.errors.length ? 'failed' : 'done'
      job.message = control.cancelled ? 'Cancelled.' : (message ?? null)
    } catch (error) {
      job.state = control.cancelled || error instanceof Cancelled ? 'cancelled' : 'failed'
      job.message = job.state === 'cancelled' ? 'Cancelled.' : error instanceof Error ? error.message : String(error)
    }
    job.finishedAt = Date.now()
  })()

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
  control.cancelled = true
  for (const handler of control.onCancel) {
    try {
      handler()
    } catch {
      // Already stopped.
    }
  }
  return true
}

export function clearFinished() {
  for (const [id, control] of jobs) if (control.job.state !== 'running') jobs.delete(id)
}

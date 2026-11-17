import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import { api, messageOf, post } from '@/lib/api'
import type { Job } from '@/lib/types'

export const jobs = ref<Job[]>([])
export const running = computed(() => jobs.value.filter((job) => job.state === 'running'))

type Listener = (folders: string[]) => void
const listeners = new Set<Listener>()
const known = new Map<string, Job['state']>()
let timer: ReturnType<typeof setTimeout> | undefined

/** Called with the folders a finished job touched, so open views can refresh. */
export function onJobFinished(listener: Listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

async function poll() {
  clearTimeout(timer)
  try {
    const list = await api<Job[]>('/jobs')
    for (const job of list) {
      const before = known.get(job.id)
      if (before === 'running' && job.state !== 'running') {
        if (job.state === 'done') toast.success(job.message ?? `${job.title}: done.`)
        else if (job.state === 'failed') {
          toast.error(job.message && job.message !== 'null' ? job.message : `${job.title}: finished with errors.`, {
            description: job.errors.slice(0, 3).join('\n') || undefined,
          })
        } else toast(`${job.title}: cancelled.`)
        for (const listener of listeners) listener(job.folders)
      }
      known.set(job.id, job.state)
    }
    jobs.value = list
  } catch {
    // Tried again on the next tick.
  }
  timer = setTimeout(poll, running.value.length ? 800 : 5000)
}

export function startPolling() {
  if (!timer) void poll()
}

/** Registers a job the server just started and follows it closely. */
export function track(job: Job) {
  known.set(job.id, 'running')
  jobs.value = [job, ...jobs.value.filter((item) => item.id !== job.id)]
  void poll()
}

export async function cancel(job: Job) {
  try {
    await post(`/jobs/${job.id}/cancel`)
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  void poll()
}

export async function clearFinished() {
  jobs.value = await post<Job[]>('/jobs/clear').catch(() => jobs.value)
}

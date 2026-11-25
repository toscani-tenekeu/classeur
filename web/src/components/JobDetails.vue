<script setup lang="ts">
import { FolderOpenIcon } from '@lucide/vue'
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import StatusBadge from '@/components/StatusBadge.vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { cancel, jobs } from '@/composables/useJobs'
import { useNow } from '@/composables/useNow'
import { bytes, dateTime, elapsed } from '@/lib/format'

const props = defineProps<{ id: string | null }>()
const open = defineModel<boolean>('open', { default: false })
const router = useRouter()
const now = useNow()

const job = computed(() => jobs.value.find((item) => item.id === props.id) ?? null)
const STATE = { running: 'Running', done: 'Done', failed: 'Finished with problems', cancelled: 'Cancelled' } as const
const tone = computed(() => {
  const state = job.value?.state
  return state === 'done' ? 'good' : state === 'failed' ? 'bad' : state === 'running' ? 'warn' : 'idle'
})

const spent = computed(() => (job.value ? (job.value.finishedAt ?? now.value) - job.value.startedAt : 0))
const progress = computed(() => (job.value?.total ? Math.min(100, (job.value.done / job.value.total) * 100) : null))
const amount = computed(() => {
  const item = job.value
  if (!item) return ''
  if (item.unit === 'items') return item.total ? `${item.done} of ${item.total} items` : `${item.done} items`
  return item.total ? `${bytes(item.done)} of ${bytes(item.total)}` : bytes(item.done)
})
/** Bytes a second so far, for copies, moves, downloads and archives. */
const speed = computed(() => {
  const item = job.value
  if (!item || item.unit !== 'bytes' || spent.value < 2000 || !item.done) return null
  return `${bytes(item.done / (spent.value / 1000))}/s`
})
const left = computed(() => {
  const item = job.value
  if (!item || item.state !== 'running' || !item.total || item.done <= 0 || item.done >= item.total || spent.value < 3000) return null
  return `about ${elapsed((spent.value / item.done) * (item.total - item.done))} left`
})

function openFolder(folder: string) {
  open.value = false
  void router.push({ path: '/files', query: { path: folder } })
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent v-if="job" class="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle class="pr-6 break-words">{{ job.title }}</DialogTitle>
        <DialogDescription class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <StatusBadge :tone="tone">{{ STATE[job.state] }}</StatusBadge>
          <span>Started {{ dateTime(job.startedAt) }}</span>
          <span>{{ job.state === 'running' ? 'Running for' : 'Took' }} {{ elapsed(spent) }}</span>
        </DialogDescription>
      </DialogHeader>

      <div class="flex min-w-0 flex-col gap-4">
        <div v-if="job.state === 'running'" class="flex flex-col gap-2">
          <Progress v-if="progress !== null" :model-value="progress" />
          <p class="text-muted-foreground flex flex-wrap gap-x-3 text-sm tabular-nums">
            <span>{{ amount }}</span>
            <span v-if="speed">{{ speed }}</span>
            <span v-if="left">{{ left }}</span>
          </p>
          <p v-if="job.now" class="truncate font-mono text-xs" :title="job.now">{{ job.now }}</p>
        </div>
        <p v-else-if="job.message" class="text-sm break-words">{{ job.message }}</p>

        <div v-if="job.errors.length" class="flex flex-col gap-1">
          <p class="text-sm font-medium">Problems ({{ job.errors.length }})</p>
          <ul class="text-destructive bg-muted max-h-48 overflow-y-auto rounded-md border p-3 text-xs">
            <li v-for="problem in job.errors" :key="problem" class="break-all">{{ problem }}</li>
          </ul>
        </div>

        <div v-if="job.folders.length" class="flex flex-col gap-1">
          <p class="text-sm font-medium">Folders</p>
          <ul class="flex flex-col gap-1">
            <li v-for="folder in job.folders" :key="folder">
              <Button variant="link" size="sm" class="h-auto p-0 font-mono text-xs" @click="openFolder(folder)">
                <FolderOpenIcon data-icon="inline-start" />
                {{ folder }}
              </Button>
            </li>
          </ul>
        </div>
      </div>

      <DialogFooter>
        <Button v-if="job.state === 'running'" variant="destructive" @click="cancel(job)">Cancel task</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

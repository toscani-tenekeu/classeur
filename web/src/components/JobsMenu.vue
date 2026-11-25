<script setup lang="ts">
import { ArrowDownUpIcon, CircleCheckIcon, CircleXIcon, XIcon } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'
import JobDetails from '@/components/JobDetails.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { cancel, clearFinished, jobs, running, startPolling } from '@/composables/useJobs'
import { activeUploads, cancelUpload, clearUploads, uploads } from '@/composables/useUploads'
import { bytes } from '@/lib/format'
import type { Job } from '@/lib/types'

onMounted(startPolling)

const busy = computed(() => running.value.length + activeUploads.value.length)
const hasFinished = computed(
  () => jobs.value.some((job) => job.state !== 'running') || uploads.value.some((item) => !['waiting', 'sending'].includes(item.state)),
)

function progress(job: Job) {
  if (!job.total) return null
  return Math.min(100, (job.done / job.total) * 100)
}

function amount(job: Job) {
  if (job.unit === 'items') return job.total ? `${job.done} of ${job.total}` : `${job.done}`
  return job.total ? `${bytes(job.done)} of ${bytes(job.total)}` : bytes(job.done)
}

const menu = ref(false)
const details = ref(false)
const chosen = ref<string | null>(null)
function show(job: Job) {
  chosen.value = job.id
  menu.value = false
  details.value = true
}

function clear() {
  void clearFinished()
  clearUploads()
}
</script>

<template>
  <Popover v-model:open="menu">
    <PopoverTrigger as-child>
      <Button variant="ghost" size="sm" aria-label="Transfers and tasks">
        <Spinner v-if="busy" />
        <ArrowDownUpIcon v-else />
        <span class="hidden sm:inline">Tasks</span>
        <Badge v-if="busy" variant="secondary" class="tabular-nums">{{ busy }}</Badge>
      </Button>
    </PopoverTrigger>
    <PopoverContent align="end" class="w-96 p-0">
      <div class="flex items-center justify-between border-b px-4 py-3">
        <p class="text-sm font-medium">Tasks</p>
        <Button v-if="hasFinished" variant="ghost" size="xs" @click="clear">Clear finished</Button>
      </div>
      <ScrollArea class="max-h-96">
        <ul v-if="jobs.length || uploads.length" class="divide-y">
          <li v-for="item in [...uploads].reverse()" :key="`u${item.key}`" class="flex flex-col gap-1.5 px-4 py-3">
            <div class="flex items-center gap-2">
              <Spinner v-if="item.state === 'sending' || item.state === 'waiting'" class="size-3.5" />
              <CircleCheckIcon v-else-if="item.state === 'done' || item.state === 'skipped'" class="text-muted-foreground size-3.5" />
              <CircleXIcon v-else class="text-destructive size-3.5" />
              <p class="min-w-0 flex-1 truncate text-sm" :title="item.name">Upload {{ item.name }}</p>
              <Button v-if="item.state === 'sending' || item.state === 'waiting'" variant="ghost" size="icon-xs" aria-label="Cancel" @click="cancelUpload(item)">
                <XIcon />
              </Button>
            </div>
            <Progress v-if="item.state === 'sending'" :model-value="item.size ? (item.sent / item.size) * 100 : 100" />
            <p class="text-muted-foreground text-xs">
              <template v-if="item.state === 'failed'">{{ item.error }}</template>
              <template v-else-if="item.state === 'skipped'">Skipped: a file with that name is already there.</template>
              <template v-else-if="item.state === 'cancelled'">Cancelled</template>
              <template v-else-if="item.state === 'waiting'">Waiting · {{ bytes(item.size) }}</template>
              <template v-else>{{ bytes(item.sent) }} of {{ bytes(item.size) }}</template>
            </p>
          </li>
          <li v-for="job in jobs" :key="job.id" class="flex flex-col gap-1.5 px-4 py-3">
            <div class="flex items-center gap-2">
              <Spinner v-if="job.state === 'running'" class="size-3.5" />
              <CircleCheckIcon v-else-if="job.state === 'done'" class="text-muted-foreground size-3.5" />
              <CircleXIcon v-else class="text-destructive size-3.5" />
              <button type="button" class="min-w-0 flex-1 truncate text-left text-sm" :title="job.title" @click="show(job)">{{ job.title }}</button>
              <Button v-if="job.state === 'running'" variant="ghost" size="icon-xs" :aria-label="`Cancel ${job.title}`" @click="cancel(job)">
                <XIcon />
              </Button>
            </div>
            <Progress v-if="job.state === 'running' && progress(job) !== null" :model-value="progress(job)!" />
            <div class="flex items-center gap-2">
              <p class="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                <template v-if="job.state === 'running'">{{ amount(job) }}<template v-if="job.now"> · {{ job.now }}</template></template>
                <template v-else>{{ job.message }}</template>
              </p>
              <Button variant="link" size="xs" class="h-auto shrink-0 p-0" @click="show(job)">Details</Button>
            </div>
            <ul v-if="job.errors.length" class="text-destructive max-h-20 overflow-y-auto text-xs">
              <li v-for="problem in job.errors.slice(0, 5)" :key="problem" class="break-all">{{ problem }}</li>
              <li v-if="job.errors.length > 5">and {{ job.errors.length - 5 }} more</li>
            </ul>
          </li>
        </ul>
        <Empty v-else class="py-8">
          <EmptyHeader>
            <EmptyTitle>Nothing running</EmptyTitle>
            <EmptyDescription>Copies, uploads and archives show their progress here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </ScrollArea>
    </PopoverContent>
  </Popover>
  <JobDetails v-if="chosen" :id="chosen" :key="chosen" v-model:open="details" />
</template>

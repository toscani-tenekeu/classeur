<script setup lang="ts">
import { ref, watch } from 'vue'
import { CircleCheckIcon, CircleDashedIcon, CircleHelpIcon, ExternalLinkIcon, TriangleAlertIcon } from '@lucide/vue'
import StatusBadge from '@/components/StatusBadge.vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { api, messageOf } from '@/lib/api'
import { symbolic, typeLabel } from '@/lib/files'
import { bytes, dateTime } from '@/lib/format'
import type { Details, FileUse } from '@/lib/types'

const props = defineProps<{ path: string | null }>()
const open = defineModel<boolean>('open', { required: true })

const details = ref<Details | null>(null)
const error = ref('')
const size = ref<number | null>(null)
const measuring = ref(false)

// Where a file is used: a website, an old release, a project or a program. Checked when the panel opens;
// closing it or choosing another file stops the check on the server.
const use = ref<FileUse | null>(null)
const useError = ref('')
const checking = ref(false)
let checkAbort: AbortController | null = null

async function checkUse(path: string) {
  checkAbort?.abort()
  const abort = new AbortController()
  checkAbort = abort
  checking.value = true
  try {
    use.value = await api<FileUse>(`/fs/usage?path=${encodeURIComponent(path)}`, { signal: abort.signal })
  } catch (failure) {
    if (!abort.signal.aborted) useError.value = messageOf(failure)
  }
  if (checkAbort === abort) checking.value = false
}

watch([open, () => props.path], async ([visible, path]) => {
  checkAbort?.abort()
  checking.value = false
  use.value = null
  useError.value = ''
  if (!visible || !path) return
  details.value = null
  error.value = ''
  size.value = null
  try {
    details.value = await api<Details>(`/fs/details?path=${encodeURIComponent(path)}`)
    if (details.value.kind === 'file') void checkUse(path)
  } catch (failure) {
    error.value = messageOf(failure)
  }
})

const gitLabel = { tracked: 'kept in git', untracked: 'not committed to git', ignored: 'ignored by git' } as const

async function measure() {
  if (!props.path) return
  measuring.value = true
  try {
    size.value = (await api<{ size: number }>(`/fs/size?path=${encodeURIComponent(props.path)}`)).size
  } catch (failure) {
    error.value = messageOf(failure)
  }
  measuring.value = false
}
</script>

<template>
  <Sheet v-model:open="open">
    <SheetContent class="w-full gap-0 sm:max-w-md">
      <SheetHeader>
        <SheetTitle class="break-all">{{ details?.name ?? 'Details' }}</SheetTitle>
        <SheetDescription class="font-mono text-xs break-all">{{ path }}</SheetDescription>
      </SheetHeader>
      <div class="flex flex-col gap-4 overflow-y-auto px-4 pb-6">
        <Alert v-if="error" variant="destructive">
          <AlertDescription>{{ error }}</AlertDescription>
        </Alert>
        <template v-if="details">
          <Alert v-if="details.sensitive">
            <TriangleAlertIcon />
            <AlertDescription>The server depends on this. A mistake here can lock you out.</AlertDescription>
          </Alert>
          <dl class="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2.5 text-sm">
            <dt class="text-muted-foreground">Type</dt>
            <dd>{{ typeLabel(details) }}</dd>
            <template v-if="details.target">
              <dt class="text-muted-foreground">Points to</dt>
              <dd class="font-mono text-xs break-all">{{ details.target }}</dd>
            </template>
            <dt class="text-muted-foreground">Size</dt>
            <dd class="flex items-center gap-2">
              <template v-if="details.kind === 'directory'">
                <span v-if="size !== null">{{ bytes(size) }}</span>
                <Button v-else variant="outline" size="xs" :disabled="measuring" @click="measure">
                  <Spinner v-if="measuring" data-icon="inline-start" />
                  Measure
                </Button>
              </template>
              <template v-else>{{ bytes(details.size) }} <span class="text-muted-foreground">({{ details.size.toLocaleString() }} bytes)</span></template>
            </dd>
            <dt class="text-muted-foreground">Permissions</dt>
            <dd class="font-mono">{{ details.mode }} · {{ symbolic(details.mode) }}</dd>
            <dt class="text-muted-foreground">Owner</dt>
            <dd>{{ details.owner }} <span class="text-muted-foreground">({{ details.uid }})</span></dd>
            <dt class="text-muted-foreground">Group</dt>
            <dd>{{ details.group }} <span class="text-muted-foreground">({{ details.gid }})</span></dd>
            <dt class="text-muted-foreground">Modified</dt>
            <dd>{{ dateTime(details.modified) }}</dd>
            <dt class="text-muted-foreground">Status changed</dt>
            <dd>{{ dateTime(details.changed) }}</dd>
            <dt class="text-muted-foreground">Last opened</dt>
            <dd>{{ dateTime(details.accessed) }}</dd>
            <template v-if="details.created">
              <dt class="text-muted-foreground">Created</dt>
              <dd>{{ dateTime(details.created) }}</dd>
            </template>
            <dt class="text-muted-foreground">Inode</dt>
            <dd class="font-mono">{{ details.inode }} · {{ details.links }} {{ details.links === 1 ? 'link' : 'links' }}</dd>
            <dt class="text-muted-foreground">Can be changed</dt>
            <dd>{{ details.writable ? 'Yes' : 'No' }}{{ details.removable ? '' : ', cannot be removed' }}</dd>
          </dl>

          <section v-if="details.kind === 'file'" class="flex flex-col gap-2 border-t pt-4">
            <h3 class="text-sm font-medium">Where it is used</h3>
            <template v-if="use">
              <StatusBadge :tone="use.use === 'used' ? 'good' : use.use === 'maybe' ? 'warn' : 'idle'" class="self-start">
                <CircleCheckIcon v-if="use.use === 'used'" />
                <CircleHelpIcon v-else-if="use.use === 'maybe'" />
                <CircleDashedIcon v-else />
                {{ use.label }}
              </StatusBadge>
              <ul class="text-muted-foreground flex list-disc flex-col gap-1 pl-5 text-sm">
                <li v-for="reason in use.reasons" :key="reason" class="break-words">{{ reason }}</li>
              </ul>
              <p v-if="use.project" class="text-sm">
                Project <span class="font-mono text-xs break-all">{{ use.project.root }}</span>
                <span v-if="use.project.git" class="text-muted-foreground">, {{ gitLabel[use.project.git] }}</span>
              </p>
              <Button v-if="use.site" variant="outline" size="sm" class="self-start" as-child>
                <a :href="use.site.url" target="_blank" rel="noreferrer noopener">
                  <ExternalLinkIcon data-icon="inline-start" />
                  Open on {{ use.site.name }}
                </a>
              </Button>
              <div v-if="use.references.length" class="flex flex-col gap-1">
                <p class="text-sm">Referred to in <span class="text-muted-foreground">({{ use.referenceCount }})</span></p>
                <ul class="bg-muted max-h-40 overflow-y-auto rounded-md border p-3 font-mono text-xs">
                  <li v-for="entry in use.references" :key="`${entry.file}:${entry.line}`" class="break-all">
                    {{ entry.file }}<span class="text-muted-foreground">:{{ entry.line }}</span>
                  </li>
                </ul>
              </div>
            </template>
            <div v-else-if="checking" class="text-muted-foreground flex items-center gap-2 text-sm">
              <Spinner />
              Checking websites, projects and programs…
            </div>
            <p v-else-if="useError" class="text-muted-foreground text-sm">{{ useError }}</p>
          </section>
        </template>
        <div v-else-if="!error" class="flex flex-col gap-2">
          <Skeleton v-for="index in 8" :key="index" class="h-5" />
        </div>
      </div>
    </SheetContent>
  </Sheet>
</template>

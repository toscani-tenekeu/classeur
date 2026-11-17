<script setup lang="ts">
import { ref, watch } from 'vue'
import { TriangleAlertIcon } from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { api, messageOf } from '@/lib/api'
import { symbolic, typeLabel } from '@/lib/files'
import { bytes, dateTime } from '@/lib/format'
import type { Details } from '@/lib/types'

const props = defineProps<{ path: string | null }>()
const open = defineModel<boolean>('open', { required: true })

const details = ref<Details | null>(null)
const error = ref('')
const size = ref<number | null>(null)
const measuring = ref(false)

watch([open, () => props.path], async ([visible, path]) => {
  if (!visible || !path) return
  details.value = null
  error.value = ''
  size.value = null
  try {
    details.value = await api<Details>(`/fs/details?path=${encodeURIComponent(path)}`)
  } catch (failure) {
    error.value = messageOf(failure)
  }
})

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
        </template>
        <div v-else-if="!error" class="flex flex-col gap-2">
          <Skeleton v-for="index in 8" :key="index" class="h-5" />
        </div>
      </div>
    </SheetContent>
  </Sheet>
</template>

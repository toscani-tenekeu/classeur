<script setup lang="ts">
import { FileIcon, FolderIcon } from '@lucide/vue'
import { ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { track } from '@/composables/useJobs'
import { api, messageOf, post } from '@/lib/api'
import { parentOf } from '@/lib/files'
import { bytes } from '@/lib/format'
import type { ArchiveListing, Job } from '@/lib/types'

const props = defineProps<{ path: string | null }>()
const open = defineModel<boolean>('open', { required: true })

const listing = ref<ArchiveListing | null>(null)
const error = ref('')

watch(open, async (value) => {
  if (!value || !props.path) return
  listing.value = null
  error.value = ''
  try {
    listing.value = await api<ArchiveListing>(`/fs/archive?path=${encodeURIComponent(props.path)}`)
  } catch (failure) {
    error.value = messageOf(failure)
  }
})

async function extract() {
  if (!props.path) return
  try {
    track(await post<Job>('/fs/extract', { path: props.path }))
    open.value = false
  } catch (failure) {
    toast.error(messageOf(failure))
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="flex max-h-[90svh] flex-col sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle class="break-all pr-6">{{ path?.split('/').at(-1) }}</DialogTitle>
        <DialogDescription>
          <template v-if="listing">
            {{ listing.count }} {{ listing.count === 1 ? 'item' : 'items' }}, {{ bytes(listing.total) }} once extracted.
            It is extracted into <span class="font-mono">{{ parentOf(listing.path) }}</span>; nothing there is overwritten.
          </template>
          <template v-else>Reading the archive…</template>
        </DialogDescription>
      </DialogHeader>
      <Alert v-if="error" variant="destructive">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>
      <div v-else-if="!listing" class="flex justify-center py-10"><Spinner /></div>
      <ScrollArea v-else class="h-[55svh] rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead class="text-right">Size</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="entry in listing.entries" :key="entry.name">
              <TableCell class="w-full max-w-0">
                <span class="flex items-center gap-2">
                  <FolderIcon v-if="entry.directory" class="text-muted-foreground size-4 shrink-0" />
                  <FileIcon v-else class="text-muted-foreground size-4 shrink-0" />
                  <span class="truncate font-mono text-xs" :title="entry.name">{{ entry.name }}</span>
                </span>
              </TableCell>
              <TableCell class="text-right tabular-nums">{{ entry.directory ? '' : bytes(entry.size) }}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
        <p v-if="listing.truncated" class="text-muted-foreground p-3 text-sm">Only the first 2000 items are listed.</p>
      </ScrollArea>
      <DialogFooter>
        <Button variant="outline" @click="open = false">Close</Button>
        <Button :disabled="!listing" @click="extract">Extract here</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

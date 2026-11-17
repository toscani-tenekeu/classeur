<script setup lang="ts">
import { DownloadIcon, PencilIcon, RefreshCwIcon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { api, messageOf } from '@/lib/api'
import { downloadUrl, type Opener, rawUrl } from '@/lib/files'
import { bytes } from '@/lib/format'
import type { Entry } from '@/lib/types'

const props = defineProps<{ entry: Entry | null; opener: Opener }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ edit: [path: string] }>()

const lines = ref<string[] | null>(null)
const error = ref('')
const loading = ref(false)

const isText = computed(() => props.opener === 'text' || props.opener === 'other')

async function loadTail() {
  if (!props.entry) return
  loading.value = true
  error.value = ''
  try {
    lines.value = (await api<{ lines: string[] }>(`/fs/tail?path=${encodeURIComponent(props.entry.path)}&lines=1000`)).lines
  } catch (failure) {
    error.value = messageOf(failure)
  }
  loading.value = false
}

watch(open, (value) => {
  lines.value = null
  if (value && isText.value) void loadTail()
})
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent v-if="entry" class="flex max-h-[90svh] flex-col sm:max-w-4xl">
      <DialogHeader>
        <DialogTitle class="break-all pr-6">{{ entry.name }}</DialogTitle>
        <DialogDescription>
          {{ bytes(entry.size) }}<template v-if="isText"> · the last 1000 lines</template>
        </DialogDescription>
      </DialogHeader>

      <div class="min-h-0 flex-1">
        <img
          v-if="opener === 'image'"
          :src="rawUrl(entry.path)"
          :alt="entry.name"
          class="bg-muted mx-auto max-h-[70svh] rounded-md object-contain"
        />
        <video v-else-if="opener === 'video'" :src="rawUrl(entry.path)" controls class="max-h-[70svh] w-full rounded-md bg-black" />
        <audio v-else-if="opener === 'audio'" :src="rawUrl(entry.path)" controls class="w-full" />
        <iframe v-else-if="opener === 'pdf'" :src="rawUrl(entry.path)" :title="entry.name" class="h-[70svh] w-full rounded-md border" />
        <template v-else>
          <Alert v-if="error" variant="destructive">
            <AlertDescription>{{ error }}</AlertDescription>
          </Alert>
          <div v-else-if="!lines" class="flex justify-center py-10"><Spinner /></div>
          <ScrollArea v-else class="bg-muted h-[60svh] rounded-md border">
            <pre class="p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">{{ lines.join('\n') || 'The file is empty.' }}</pre>
          </ScrollArea>
        </template>
      </div>

      <div class="flex flex-wrap justify-end gap-2">
        <Button v-if="isText" variant="outline" :disabled="loading" @click="loadTail">
          <RefreshCwIcon data-icon="inline-start" />
          Reload
        </Button>
        <Button v-if="opener === 'text'" variant="outline" @click="emit('edit', entry.path)">
          <PencilIcon data-icon="inline-start" />
          Edit
        </Button>
        <Button as-child>
          <a :href="downloadUrl(entry.path)" download>
            <DownloadIcon data-icon="inline-start" />
            Download
          </a>
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { ArrowLeftIcon, DownloadIcon, LockIcon, RefreshCwIcon, SaveIcon, TriangleAlertIcon, WrapTextIcon } from '@lucide/vue'
import { useLocalStorage } from '@vueuse/core'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import CodeEditor from '@/components/CodeEditor.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Toggle } from '@/components/ui/toggle'
import { api, ApiError, messageOf } from '@/lib/api'
import { downloadUrl, nameOf, parentOf } from '@/lib/files'
import { bytes } from '@/lib/format'
import type { TextFile } from '@/lib/types'

const route = useRoute()
const router = useRouter()
const path = computed(() => (typeof route.query.path === 'string' ? route.query.path : ''))

const file = ref<TextFile | null>(null)
const error = ref('')
const draft = ref('')
const saving = ref(false)
const wrap = useLocalStorage('classeur.wrap', false)
const editor = ref<InstanceType<typeof CodeEditor> | null>(null)
const conflict = ref(false)
const sensitiveConfirm = ref(false)
const leaveTo = ref<string | null>(null)

const dirty = computed(() => file.value !== null && draft.value !== file.value.content)
const readOnly = computed(() => !file.value?.writable)

async function load() {
  error.value = ''
  try {
    const result = await api<TextFile>(`/fs/text?path=${encodeURIComponent(path.value)}`)
    file.value = result
    draft.value = result.content
    editor.value?.replace(result.content)
    document.title = `${nameOf(result.path)} · Classeur`
  } catch (failure) {
    error.value = messageOf(failure)
    file.value = null
  }
}

async function save(force = false) {
  if (!file.value || readOnly.value || saving.value) return
  if (!dirty.value) return
  if (file.value.sensitive && !force) {
    sensitiveConfirm.value = true
    return
  }
  saving.value = true
  try {
    const result = await api<{ modified: number; size: number }>('/fs/text', {
      method: 'PUT',
      body: { path: file.value.path, content: draft.value, modified: file.value.modified },
    })
    file.value = { ...file.value, content: draft.value, modified: result.modified, size: result.size }
    toast.success('Saved.')
  } catch (failure) {
    if (failure instanceof ApiError && failure.status === 409) conflict.value = true
    else toast.error(messageOf(failure))
  }
  saving.value = false
}

/** Saves over a version someone else changed, after the user agreed. */
async function overwrite() {
  if (!file.value) return
  const current = await api<TextFile>(`/fs/text?path=${encodeURIComponent(file.value.path)}`).catch(() => null)
  if (current) file.value = { ...file.value, modified: current.modified }
  await save(true)
}

async function reload() {
  conflict.value = false
  await load()
}

watch(path, load)
onMounted(load)

function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value) event.preventDefault()
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))

onBeforeRouteLeave((to) => {
  if (!dirty.value || leaveTo.value === to.fullPath) return true
  leaveTo.value = to.fullPath
  return false
})

function leave() {
  const target = leaveTo.value
  if (target) void router.push(target)
}

function back() {
  void router.push({ path: '/files', query: { path: parentOf(path.value) } })
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <Button variant="outline" size="icon" aria-label="Back to the folder" @click="back"><ArrowLeftIcon /></Button>
    <div class="min-w-0 flex-1">
      <p class="truncate font-medium">
        {{ nameOf(path) }}
        <Badge v-if="dirty" variant="secondary" class="ml-1">Not saved</Badge>
        <Badge v-if="readOnly && file" variant="outline" class="ml-1"><LockIcon /> Read only</Badge>
      </p>
      <p class="text-muted-foreground truncate font-mono text-xs">
        {{ parentOf(path) }}<template v-if="file"> · {{ bytes(file.size) }}</template>
      </p>
    </div>
    <Toggle v-model="wrap" variant="outline" size="sm" aria-label="Wrap long lines"><WrapTextIcon /> Wrap</Toggle>
    <Button variant="outline" size="sm" as-child>
      <a :href="downloadUrl(path)" download><DownloadIcon data-icon="inline-start" /> Download</a>
    </Button>
    <Button variant="outline" size="sm" @click="dirty ? (conflict = true) : reload()">
      <RefreshCwIcon data-icon="inline-start" /> Reload
    </Button>
    <Button size="sm" :disabled="!dirty || readOnly || saving" @click="save()">
      <Spinner v-if="saving" data-icon="inline-start" />
      <SaveIcon v-else data-icon="inline-start" />
      Save
    </Button>
  </div>

  <Alert v-if="file?.sensitive">
    <TriangleAlertIcon />
    <AlertTitle>The server depends on this file</AlertTitle>
    <AlertDescription>
      A mistake here can lock you out or stop the server from starting. Keep an SSH session open while you test the change.
      <template v-if="/sudoers|sshd_config/.test(file.path)">Classeur checks this file with its own program before saving and refuses a broken version.</template>
    </AlertDescription>
  </Alert>
  <Alert v-if="file?.protected">
    <LockIcon />
    <AlertDescription>{{ file.protected }}</AlertDescription>
  </Alert>
  <Alert v-if="error" variant="destructive">
    <AlertTitle>The file cannot be opened here</AlertTitle>
    <AlertDescription>
      {{ error }}
      <Button variant="link" class="h-auto p-0" as-child><a :href="downloadUrl(path)" download>Download it instead</a></Button>
    </AlertDescription>
  </Alert>

  <Card class="min-h-[60svh] flex-1 overflow-hidden py-0">
    <CodeEditor
      v-if="file"
      ref="editor"
      :key="file.path"
      :content="file.content"
      :filename="file.path"
      :read-only="readOnly"
      :wrap="wrap"
      @change="(value) => (draft = value)"
      @save="save()"
    />
    <div v-else-if="!error" class="flex flex-col gap-2 p-4">
      <Skeleton v-for="index in 12" :key="index" class="h-4" :style="{ width: `${40 + ((index * 37) % 55)}%` }" />
    </div>
  </Card>

  <AlertDialog v-model:open="sensitiveConfirm">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Save {{ nameOf(path) }}?</AlertDialogTitle>
        <AlertDialogDescription>
          The server depends on this file. If the new version is wrong, you may not be able to sign in or the server may not
          start. Make sure you have another way in, such as an open SSH session or your provider’s console.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction @click="save(true)">Save</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>

  <AlertDialog v-model:open="conflict">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{{ dirty ? 'Your changes and the file on the server differ' : 'Reload the file?' }}</AlertDialogTitle>
        <AlertDialogDescription>
          <template v-if="dirty">
            The file may have changed on the server since you opened it. Reloading shows the server’s version and drops
            your changes. Saving anyway replaces the server’s version with yours.
          </template>
          <template v-else>The editor shows the version on the server.</template>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <Button variant="outline" @click="reload">Reload and drop my changes</Button>
        <AlertDialogAction v-if="dirty && !readOnly" @click="overwrite">Save mine anyway</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>

  <AlertDialog :open="!!leaveTo" @update:open="(open: boolean) => { if (!open) leaveTo = null }">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
        <AlertDialogDescription>Your changes to {{ nameOf(path) }} will be lost.</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Stay</AlertDialogCancel>
        <AlertDialogAction variant="destructive" @click="leave">Leave</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { track } from '@/composables/useJobs'
import { api, messageOf, post } from '@/lib/api'
import { nameOf } from '@/lib/files'
import type { Account, Entry, Job } from '@/lib/types'

const props = defineProps<{ entries: Entry[] }>()
const open = defineModel<boolean>('open', { required: true })

const tab = ref('permissions')
const fileMode = ref('644')
const folderMode = ref('755')
const recursive = ref(false)
const user = ref('')
const group = ref('')
const accounts = ref<{ users: Account[]; groups: Account[] } | null>(null)
const busy = ref(false)

const hasFolders = computed(() => props.entries.some((entry) => entry.kind === 'directory'))
const hasFiles = computed(() => props.entries.some((entry) => entry.kind !== 'directory'))
const title = computed(() => (props.entries.length === 1 ? props.entries[0]!.name : `${props.entries.length} items`))
const valid = (mode: string) => /^[0-7]{3,4}$/.test(mode)

const ROLES = [
  { key: 0, label: 'Owner' },
  { key: 1, label: 'Group' },
  { key: 2, label: 'Others' },
]
const BITS = [
  { bit: 4, label: 'Read' },
  { bit: 2, label: 'Write' },
  { bit: 1, label: 'Run / open' },
]

watch(open, async (value) => {
  if (!value) return
  const first = props.entries[0]
  const fileEntry = props.entries.find((entry) => entry.kind !== 'directory')
  const folderEntry = props.entries.find((entry) => entry.kind === 'directory')
  fileMode.value = fileEntry ? fileEntry.mode.slice(-3) : '644'
  folderMode.value = folderEntry ? folderEntry.mode.slice(-3) : '755'
  recursive.value = false
  user.value = first?.owner ?? ''
  group.value = first?.group ?? ''
  tab.value = 'permissions'
  accounts.value ??= await api<{ users: Account[]; groups: Account[] }>('/accounts').catch(() => null)
})

function has(mode: string, role: number, bit: number) {
  return ((Number(mode.slice(-3)[role]) || 0) & bit) !== 0
}

function toggle(which: 'file' | 'folder', role: number, bit: number, on: boolean) {
  const target = which === 'file' ? fileMode : folderMode
  const digits = target.value.slice(-3).padStart(3, '0').split('').map(Number)
  digits[role] = on ? digits[role]! | bit : digits[role]! & ~bit
  target.value = digits.join('')
}

const worldWritable = computed(
  () => (hasFiles.value && has(fileMode.value, 2, 2)) || (hasFolders.value && has(folderMode.value, 2, 2)),
)
const noOwnerAccess = computed(
  () => (hasFiles.value && !has(fileMode.value, 0, 4)) || (hasFolders.value && !has(folderMode.value, 0, 1)),
)

async function apply() {
  busy.value = true
  try {
    const paths = props.entries.map((entry) => entry.path)
    const body =
      tab.value === 'permissions'
        ? {
            paths,
            fileMode: hasFiles.value || recursive.value ? fileMode.value : null,
            folderMode: hasFolders.value ? folderMode.value : null,
            recursive: recursive.value,
          }
        : { paths, user: user.value, group: group.value, recursive: recursive.value }
    track(await post<Job>('/fs/permissions', body))
    open.value = false
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  busy.value = false
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Permissions of {{ title }}</DialogTitle>
        <DialogDescription>Who may read, change and run {{ entries.length === 1 ? 'it' : 'them' }}.</DialogDescription>
      </DialogHeader>

      <Tabs v-model="tab">
        <TabsList>
          <TabsTrigger value="permissions">Permissions</TabsTrigger>
          <TabsTrigger value="owner">Owner</TabsTrigger>
        </TabsList>

        <TabsContent value="permissions" class="flex flex-col gap-4 pt-2">
          <template v-for="which in (['file', 'folder'] as const)" :key="which">
            <div v-if="which === 'file' ? hasFiles || recursive : hasFolders" class="flex flex-col gap-2">
              <div class="flex items-center justify-between gap-2">
                <p class="text-sm font-medium">{{ which === 'file' ? 'Files' : 'Folders' }}</p>
                <Input
                  :model-value="which === 'file' ? fileMode : folderMode"
                  class="h-8 w-20 text-center font-mono"
                  maxlength="4"
                  :aria-label="`${which === 'file' ? 'Files' : 'Folders'} as a number`"
                  :aria-invalid="!valid(which === 'file' ? fileMode : folderMode)"
                  @update:model-value="(value) => (which === 'file' ? (fileMode = String(value)) : (folderMode = String(value)))"
                />
              </div>
              <div class="grid grid-cols-4 items-center gap-y-2 rounded-md border p-3 text-sm">
                <span />
                <span v-for="bit in BITS" :key="bit.bit" class="text-muted-foreground text-center text-xs">{{ bit.label }}</span>
                <template v-for="role in ROLES" :key="role.key">
                  <span>{{ role.label }}</span>
                  <span v-for="bit in BITS" :key="bit.bit" class="flex justify-center">
                    <Checkbox
                      :model-value="has(which === 'file' ? fileMode : folderMode, role.key, bit.bit)"
                      :aria-label="`${role.label} ${bit.label}`"
                      @update:model-value="(on) => toggle(which, role.key, bit.bit, on === true)"
                    />
                  </span>
                </template>
              </div>
            </div>
          </template>
          <Alert v-if="worldWritable" variant="destructive">
            <AlertDescription>Anyone on this server will be able to change these. That is rarely a good idea.</AlertDescription>
          </Alert>
          <Alert v-else-if="noOwnerAccess">
            <AlertDescription>The owner will not be able to read {{ hasFolders ? 'or open' : '' }} them any more.</AlertDescription>
          </Alert>
        </TabsContent>

        <TabsContent value="owner" class="pt-2">
          <FieldGroup>
            <Field>
              <FieldLabel for="owner-user">User</FieldLabel>
              <Select v-model="user">
                <SelectTrigger id="owner-user"><SelectValue placeholder="Choose a user" /></SelectTrigger>
                <SelectContent class="max-h-72">
                  <SelectItem v-for="account in accounts?.users ?? []" :key="account.name" :value="account.name">
                    {{ account.name }} <span class="text-muted-foreground">({{ account.id }})</span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel for="owner-group">Group</FieldLabel>
              <Select v-model="group">
                <SelectTrigger id="owner-group"><SelectValue placeholder="Choose a group" /></SelectTrigger>
                <SelectContent class="max-h-72">
                  <SelectItem v-for="account in accounts?.groups ?? []" :key="account.name" :value="account.name">
                    {{ account.name }} <span class="text-muted-foreground">({{ account.id }})</span>
                  </SelectItem>
                </SelectContent>
              </Select>
              <FieldError v-if="!accounts">The list of users could not be loaded.</FieldError>
            </Field>
          </FieldGroup>
        </TabsContent>
      </Tabs>

      <Field v-if="hasFolders" orientation="horizontal">
        <FieldContent>
          <FieldLabel for="recursive">Also change everything inside</FieldLabel>
          <FieldDescription>Applies to every file and folder in {{ entries.length === 1 ? nameOf(entries[0]!.path) : 'the selected folders' }}.</FieldDescription>
        </FieldContent>
        <Switch id="recursive" v-model="recursive" />
      </Field>

      <DialogFooter>
        <Button variant="outline" @click="open = false">Cancel</Button>
        <Button
          :disabled="busy || (tab === 'permissions' ? !valid(fileMode) || !valid(folderMode) : !user || !group)"
          @click="apply"
        >
          Apply
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { track } from '@/composables/useJobs'
import { messageOf, post } from '@/lib/api'
import { nameOf, parentOf } from '@/lib/files'
import type { Job } from '@/lib/types'

const props = defineProps<{ paths: string[] }>()
const open = defineModel<boolean>('open', { required: true })

const name = ref('')
const format = ref<'zip' | 'tar.gz' | 'tar.xz'>('zip')

watch(open, (value) => {
  if (!value) return
  name.value = props.paths.length === 1 ? nameOf(props.paths[0]!) : nameOf(parentOf(props.paths[0] ?? '/')) || 'archive'
  format.value = 'zip'
})

const FORMATS = [
  { value: 'zip', label: 'zip', note: 'Opens on any computer.' },
  { value: 'tar.gz', label: 'tar.gz', note: 'The usual choice on Linux. Keeps permissions and owners.' },
  { value: 'tar.xz', label: 'tar.xz', note: 'Smaller, but slower to make.' },
] as const

async function start() {
  try {
    track(await post<Job>('/fs/compress', { paths: props.paths, name: name.value, format: format.value }))
    open.value = false
  } catch (failure) {
    toast.error(messageOf(failure))
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Compress {{ paths.length === 1 ? nameOf(paths[0]!) : `${paths.length} items` }}</DialogTitle>
        <DialogDescription>The archive is made in the same folder. The originals stay as they are.</DialogDescription>
      </DialogHeader>
      <form id="compress-form" @submit.prevent="start">
        <FieldGroup>
          <Field>
            <FieldLabel for="archive-name">Archive name</FieldLabel>
            <Input id="archive-name" v-model="name" autocomplete="off" spellcheck="false" />
          </Field>
          <FieldSet>
            <FieldLegend variant="label">Format</FieldLegend>
            <RadioGroup v-model="format">
              <Field v-for="item in FORMATS" :key="item.value" orientation="horizontal">
                <RadioGroupItem :id="`format-${item.value}`" :value="item.value" />
                <FieldContent>
                  <FieldLabel :for="`format-${item.value}`">{{ item.label }}</FieldLabel>
                  <FieldDescription>{{ item.note }}</FieldDescription>
                </FieldContent>
              </Field>
            </RadioGroup>
          </FieldSet>
        </FieldGroup>
      </form>
      <DialogFooter>
        <Button variant="outline" @click="open = false">Cancel</Button>
        <Button type="submit" form="compress-form" :disabled="!name.trim()">Compress</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

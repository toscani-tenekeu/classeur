<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'

const props = defineProps<{
  title: string
  description: string
  label: string
  initial: string
  confirm: string
  /** Select the name without its extension, the way desktop file managers do on rename. */
  selectStem?: boolean
  submit: (name: string) => Promise<void>
}>()
const open = defineModel<boolean>('open', { required: true })

const name = ref('')
const error = ref('')
const busy = ref(false)

watch(open, async (value) => {
  if (!value) return
  name.value = props.initial
  error.value = ''
  await nextTick()
  const element = document.getElementById('item-name') as HTMLInputElement | null
  element?.focus()
  const dot = props.initial.lastIndexOf('.')
  element?.setSelectionRange(0, props.selectStem && dot > 0 ? dot : props.initial.length)
})

async function save() {
  const value = name.value.trim()
  if (!value) {
    error.value = 'Give a name.'
    return
  }
  if (value.includes('/')) {
    error.value = 'A name cannot contain a slash.'
    return
  }
  busy.value = true
  error.value = ''
  try {
    await props.submit(value)
    open.value = false
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : 'It did not work.'
  }
  busy.value = false
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription>{{ description }}</DialogDescription>
      </DialogHeader>
      <form id="name-form" @submit.prevent="save">
        <Field :data-invalid="!!error || undefined">
          <FieldLabel for="item-name">{{ label }}</FieldLabel>
          <Input id="item-name" v-model="name" autocomplete="off" spellcheck="false" :aria-invalid="!!error" />
          <FieldError v-if="error">{{ error }}</FieldError>
        </Field>
      </form>
      <DialogFooter>
        <Button variant="outline" @click="open = false">Cancel</Button>
        <Button type="submit" form="name-form" :disabled="busy">
          <Spinner v-if="busy" data-icon="inline-start" />
          {{ confirm }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

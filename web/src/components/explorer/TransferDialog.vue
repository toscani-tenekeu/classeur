<script setup lang="ts">
import { ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Field, FieldContent, FieldDescription, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { track } from '@/composables/useJobs'
import { messageOf, post } from '@/lib/api'
import { nameOf } from '@/lib/files'
import type { Job } from '@/lib/types'

const props = defineProps<{ op: 'copy' | 'move'; paths: string[]; destination: string }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ started: [] }>()

const conflict = ref<'rename' | 'overwrite' | 'skip'>('rename')
watch(open, (value) => {
  if (value) conflict.value = 'rename'
})

async function start() {
  try {
    const job = await post<Job>('/fs/transfer', {
      op: props.op,
      paths: props.paths,
      destination: props.destination,
      conflict: conflict.value,
    })
    track(job)
    emit('started')
  } catch (failure) {
    toast.error(messageOf(failure))
  }
}
</script>

<template>
  <AlertDialog v-model:open="open">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>
          {{ op === 'copy' ? 'Copy' : 'Move' }}
          {{ paths.length === 1 ? nameOf(paths[0]!) : `${paths.length} items` }}?
        </AlertDialogTitle>
        <AlertDialogDescription>
          {{ op === 'copy' ? 'A copy is made in' : 'The items leave their folder and go to' }}
          <span class="text-foreground font-mono break-all">{{ destination }}</span>.
          <template v-if="op === 'move'"> Programs that use them at their current place will no longer find them.</template>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <FieldSet>
        <FieldLegend variant="label">When an item with the same name is already there</FieldLegend>
        <RadioGroup v-model="conflict">
          <Field orientation="horizontal">
            <RadioGroupItem id="conflict-rename" value="rename" />
            <FieldContent>
              <FieldLabel for="conflict-rename">Keep both</FieldLabel>
              <FieldDescription>The new one gets a number, like “report (2).pdf”.</FieldDescription>
            </FieldContent>
          </Field>
          <Field orientation="horizontal">
            <RadioGroupItem id="conflict-overwrite" value="overwrite" />
            <FieldContent>
              <FieldLabel for="conflict-overwrite">Replace it</FieldLabel>
              <FieldDescription>The existing one goes to the trash, where it can be restored.</FieldDescription>
            </FieldContent>
          </Field>
          <Field orientation="horizontal">
            <RadioGroupItem id="conflict-skip" value="skip" />
            <FieldContent>
              <FieldLabel for="conflict-skip">Skip it</FieldLabel>
            </FieldContent>
          </Field>
        </RadioGroup>
      </FieldSet>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction @click="start">{{ op === 'copy' ? 'Copy' : 'Move' }}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { track } from '@/composables/useJobs'
import { messageOf, post } from '@/lib/api'
import { nameOf } from '@/lib/files'
import type { BatchResult, Job } from '@/lib/types'

const props = defineProps<{ paths: string[] }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ done: [] }>()

const permanent = ref(false)
watch(open, (value) => {
  if (value) permanent.value = false
})

async function run() {
  try {
    if (permanent.value) {
      track(await post<Job>('/fs/delete', { paths: props.paths }))
    } else {
      const result = await post<BatchResult & { moved: number }>('/fs/trash', { paths: props.paths })
      if (result.moved) toast.success(result.moved === 1 ? 'Moved to the trash.' : `${result.moved} items moved to the trash.`)
      if (result.failed.length) {
        toast.error(`${result.failed.length} could not be moved to the trash.`, {
          description: result.failed.slice(0, 3).map((item) => `${nameOf(item.path)}: ${item.message}`).join('\n'),
        })
      }
    }
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  emit('done')
}
</script>

<template>
  <AlertDialog v-model:open="open">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Delete {{ paths.length === 1 ? nameOf(paths[0]!) : `${paths.length} items` }}?</AlertDialogTitle>
        <AlertDialogDescription>
          <template v-if="permanent">
            The items and everything inside them are removed for good. They cannot be brought back.
          </template>
          <template v-else>
            The items go to the trash. You can restore them for 30 days; after that they are removed for good.
          </template>
          A program or website that uses them will stop working.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <ul class="bg-muted max-h-36 overflow-y-auto rounded-md border p-3 font-mono text-xs break-all">
        <li v-for="path in paths.slice(0, 20)" :key="path">{{ path }}</li>
        <li v-if="paths.length > 20" class="text-muted-foreground font-sans">and {{ paths.length - 20 }} more</li>
      </ul>
      <Field orientation="horizontal">
        <Checkbox id="delete-permanent" v-model="permanent" />
        <FieldContent>
          <FieldLabel for="delete-permanent">Delete permanently</FieldLabel>
          <FieldDescription>Skip the trash and free the space now.</FieldDescription>
        </FieldContent>
      </Field>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction variant="destructive" @click="run">
          {{ permanent ? 'Delete permanently' : 'Move to trash' }}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>

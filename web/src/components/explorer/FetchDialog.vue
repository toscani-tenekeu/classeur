<script setup lang="ts">
import { ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { track } from '@/composables/useJobs'
import { messageOf, post } from '@/lib/api'
import type { Job } from '@/lib/types'

const props = defineProps<{ dir: string }>()
const open = defineModel<boolean>('open', { required: true })

const url = ref('')
const name = ref('')

watch(open, (value) => {
  if (value) url.value = name.value = ''
})

async function start() {
  try {
    track(await post<Job>('/fs/fetch', { url: url.value.trim(), dir: props.dir, name: name.value.trim() }))
    open.value = false
  } catch (failure) {
    toast.error(messageOf(failure))
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Download from a web address</DialogTitle>
        <DialogDescription>
          The server downloads the file straight into <span class="text-foreground font-mono break-all">{{ dir }}</span>.
          Nothing passes through your computer.
        </DialogDescription>
      </DialogHeader>
      <form id="fetch-form" @submit.prevent="start">
        <FieldGroup>
          <Field>
            <FieldLabel for="fetch-url">Address</FieldLabel>
            <Input id="fetch-url" v-model="url" type="url" placeholder="https://example.com/file.tar.gz" autocomplete="off" required />
          </Field>
          <Field>
            <FieldLabel for="fetch-name">Save as</FieldLabel>
            <Input id="fetch-name" v-model="name" placeholder="Name taken from the address" autocomplete="off" />
            <FieldDescription>Leave empty to keep the name from the address.</FieldDescription>
          </Field>
        </FieldGroup>
      </form>
      <DialogFooter>
        <Button variant="outline" @click="open = false">Cancel</Button>
        <Button type="submit" form="fetch-form" :disabled="!url.trim()">Download</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

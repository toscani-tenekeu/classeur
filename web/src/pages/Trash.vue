<script setup lang="ts">
import { FolderIcon, RotateCcwIcon, Trash2Icon } from '@lucide/vue'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import LoadError from '@/components/LoadError.vue'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useResource } from '@/composables/useResource'
import { messageOf, post } from '@/lib/api'
import { iconFor, parentOf } from '@/lib/files'
import { bytes, dateTime } from '@/lib/format'
import type { TrashItem } from '@/lib/types'

const { data, error, refresh } = useResource<TrashItem[]>('/trash')
const selected = ref(new Set<string>())
const pending = ref<'delete' | 'empty' | null>(null)

const chosen = computed(() => (data.value ?? []).filter((item) => selected.value.has(item.id)))
const total = computed(() => (data.value ?? []).reduce((sum, item) => sum + item.size, 0))
const allSelected = computed(() => !!data.value?.length && chosen.value.length === data.value.length)

function toggle(item: TrashItem, on: boolean) {
  const next = new Set(selected.value)
  if (on) next.add(item.id)
  else next.delete(item.id)
  selected.value = next
}

async function restore(items: TrashItem[]) {
  try {
    const result = await post<{ restored: string[]; failed: { path: string; message: string }[] }>('/trash/restore', {
      ids: items.map((item) => item.id),
    })
    if (result.restored.length) {
      toast.success(result.restored.length === 1 ? `Restored to ${result.restored[0]}.` : `${result.restored.length} items restored.`)
    }
    for (const failure of result.failed.slice(0, 3)) toast.error(`${failure.path}: ${failure.message}`)
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  selected.value = new Set()
  await refresh()
}

async function purge() {
  const mode = pending.value
  pending.value = null
  try {
    const result =
      mode === 'empty'
        ? await post<{ removed: number; freed: number }>('/trash/empty')
        : await post<{ removed: number; freed: number }>('/trash/delete', { ids: chosen.value.map((item) => item.id) })
    toast.success(`${result.removed} removed for good, ${bytes(result.freed)} freed.`)
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  selected.value = new Set()
  await refresh()
}
</script>

<template>
  <LoadError :message="error" />

  <Card>
    <CardHeader>
      <CardTitle>Trash</CardTitle>
      <CardDescription>
        Deleted items wait here for 30 days, then they are removed for good.
        <template v-if="data?.length">{{ data.length }} {{ data.length === 1 ? 'item' : 'items' }}, {{ bytes(total) }}.</template>
      </CardDescription>
      <CardAction class="flex gap-2">
        <template v-if="chosen.length">
          <Button variant="outline" size="sm" @click="restore(chosen)"><RotateCcwIcon data-icon="inline-start" /> Restore {{ chosen.length }}</Button>
          <Button variant="outline" size="sm" @click="pending = 'delete'"><Trash2Icon data-icon="inline-start" /> Delete for good</Button>
        </template>
        <Button v-else-if="data?.length" variant="outline" size="sm" @click="pending = 'empty'">Empty the trash</Button>
      </CardAction>
    </CardHeader>
    <CardContent>
      <template v-if="data">
        <Table v-if="data.length">
          <TableHeader>
            <TableRow>
              <TableHead class="w-10">
                <Checkbox
                  :model-value="allSelected"
                  aria-label="Select all"
                  @update:model-value="selected = allSelected ? new Set() : new Set(data.map((item) => item.id))"
                />
              </TableHead>
              <TableHead>Name</TableHead>
              <TableHead class="text-right">Size</TableHead>
              <TableHead>Deleted</TableHead>
              <TableHead class="w-28" />
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="item in data" :key="item.id" :data-state="selected.has(item.id) ? 'selected' : undefined">
              <TableCell>
                <Checkbox
                  :model-value="selected.has(item.id)"
                  :aria-label="`Select ${item.name}`"
                  @update:model-value="(on) => toggle(item, on === true)"
                />
              </TableCell>
              <TableCell class="w-full max-w-0">
                <span class="flex items-center gap-2">
                  <FolderIcon v-if="item.directory" class="size-4 shrink-0" />
                  <component :is="iconFor({ name: item.name, kind: 'file', targetKind: null })" v-else class="text-muted-foreground size-4 shrink-0" />
                  <span class="min-w-0">
                    <span class="block truncate font-medium">{{ item.name }}</span>
                    <span class="text-muted-foreground block truncate font-mono text-xs">{{ parentOf(item.original) }}</span>
                  </span>
                </span>
              </TableCell>
              <TableCell class="text-right tabular-nums">{{ bytes(item.size) }}</TableCell>
              <TableCell class="text-muted-foreground whitespace-nowrap">{{ dateTime(item.deletedAt) }}</TableCell>
              <TableCell class="text-right">
                <Button variant="outline" size="xs" @click="restore([item])">Restore</Button>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
        <Empty v-else>
          <EmptyHeader>
            <EmptyTitle>The trash is empty</EmptyTitle>
            <EmptyDescription>Items you delete in Classeur come here first, unless you choose to delete them for good.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </template>
      <div v-else class="flex flex-col gap-2">
        <Skeleton v-for="index in 5" :key="index" class="h-10" />
      </div>
    </CardContent>
  </Card>

  <AlertDialog :open="!!pending" @update:open="(open: boolean) => { if (!open) pending = null }">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>
          {{ pending === 'empty' ? 'Empty the trash?' : `Delete ${chosen.length} ${chosen.length === 1 ? 'item' : 'items'} for good?` }}
        </AlertDialogTitle>
        <AlertDialogDescription>
          {{ bytes(pending === 'empty' ? total : chosen.reduce((sum, item) => sum + item.size, 0)) }} will be freed.
          This cannot be undone.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction variant="destructive" @click="purge">Delete for good</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>

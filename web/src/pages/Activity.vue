<script setup lang="ts">
import LoadError from '@/components/LoadError.vue'
import StatusBadge from '@/components/StatusBadge.vue'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useResource } from '@/composables/useResource'
import { bytes, dateTime } from '@/lib/format'
import type { ActivityRow } from '@/lib/types'

const { data, error } = useResource<{ rows: ActivityRow[]; freed: number }>('/activity')
</script>

<template>
  <LoadError :message="error" />

  <Card>
    <CardHeader>
      <CardTitle>Activity</CardTitle>
      <CardDescription>
        Everything done from this panel, kept for 90 days.
        <template v-if="data && data.freed">{{ bytes(data.freed) }} freed so far.</template>
      </CardDescription>
    </CardHeader>
    <CardContent>
      <Table v-if="data">
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Target</TableHead>
            <TableHead class="text-right">Freed</TableHead>
            <TableHead class="text-right">Result</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="row in data.rows" :key="row.id">
            <TableCell class="text-muted-foreground whitespace-nowrap">{{ dateTime(row.at) }}</TableCell>
            <TableCell class="font-medium">{{ row.action }}</TableCell>
            <TableCell class="max-w-80">
              <p class="truncate">{{ row.target }}</p>
              <p v-if="row.detail" class="text-muted-foreground truncate text-xs" :title="row.detail">{{ row.detail }}</p>
            </TableCell>
            <TableCell class="text-right tabular-nums">{{ row.freed ? bytes(row.freed) : '' }}</TableCell>
            <TableCell class="text-right">
              <StatusBadge :tone="row.ok ? 'good' : 'bad'">{{ row.ok ? 'Done' : 'Failed' }}</StatusBadge>
            </TableCell>
          </TableRow>
          <TableEmpty v-if="!data.rows.length" :colspan="5">Nothing has been done yet.</TableEmpty>
        </TableBody>
      </Table>
      <div v-else class="flex flex-col gap-2">
        <Skeleton v-for="index in 6" :key="index" class="h-9" />
      </div>
    </CardContent>
  </Card>
</template>

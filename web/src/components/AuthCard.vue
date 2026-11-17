<script setup lang="ts">
import { FoldersIcon } from '@lucide/vue'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

defineProps<{ title: string; description: string }>()
</script>

<template>
  <div class="bg-muted flex min-h-svh flex-col items-center justify-center gap-6 p-6">
    <div class="flex items-center gap-2 font-medium">
      <div class="bg-primary text-primary-foreground flex size-6 items-center justify-center rounded-md">
        <FoldersIcon class="size-4" />
      </div>
      Classeur
    </div>
    <Card class="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{{ title }}</CardTitle>
        <CardDescription>{{ description }}</CardDescription>
      </CardHeader>
      <CardContent>
        <slot />
      </CardContent>
    </Card>
  </div>
</template>

<script setup lang="ts">
import { TriangleAlertIcon } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

defineProps<{ message: string }>()
</script>

<template>
  <Alert v-if="message" variant="destructive">
    <TriangleAlertIcon />
    <AlertTitle>This could not be loaded</AlertTitle>
    <AlertDescription>{{ message }}</AlertDescription>
  </Alert>
</template>

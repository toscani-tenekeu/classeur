<script setup lang="ts">
import { useColorMode } from '@vueuse/core'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import 'vue-sonner/style.css'

const mode = useColorMode()
</script>

<template>
  <TooltipProvider>
    <RouterView />
  </TooltipProvider>
  <Toaster :theme="mode === 'dark' ? 'dark' : 'light'" position="bottom-right" />
</template>

<script setup lang="ts">
import { useColorMode } from '@vueuse/core'
import {
  FolderIcon, FoldersIcon, HistoryIcon, LogOutIcon, MoonIcon, SettingsIcon, SunIcon, Trash2Icon, XIcon,
} from '@lucide/vue'
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarHeader,
  SidebarGroupLabel, SidebarInset, SidebarMenu, SidebarMenuAction, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem,
  SidebarProvider, SidebarRail, SidebarTrigger,
} from '@/components/ui/sidebar'
import JobsMenu from '@/components/JobsMenu.vue'
import { favourites, loadFavourites, removeFavourite } from '@/composables/useFavourites'
import { loadUpdateState, signedIn, updateAvailable } from '@/composables/useSession'
import { post } from '@/lib/api'

const route = useRoute()
const router = useRouter()
const mode = useColorMode()

const links = [
  { to: '/files', label: 'Files', icon: FoldersIcon },
  { to: '/trash', label: 'Trash', icon: Trash2Icon },
  { to: '/activity', label: 'Activity', icon: HistoryIcon },
]

const currentFolder = computed(() => (route.path === '/files' && typeof route.query.path === 'string' ? route.query.path : null))
const label = (path: string) => (path === '/' ? 'Root (/)' : path.split('/').at(-1))
const pageTitle = computed(() => (route.name === 'Files' ? label(currentFolder.value ?? '/') : route.name))

async function signOut() {
  await post('/logout').catch(() => null)
  signedIn.value = false
  await router.push('/login')
}

onMounted(() => {
  void loadUpdateState()
  void loadFavourites()
})
</script>

<template>
  <SidebarProvider>
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" as-child>
              <RouterLink to="/files">
                <div class="bg-primary text-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                  <FoldersIcon class="size-4" />
                </div>
                <div class="grid flex-1 text-left leading-tight">
                  <span class="truncate font-semibold">Classeur</span>
                  <span class="text-muted-foreground truncate text-xs">File manager</span>
                </div>
              </RouterLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem v-for="link in links" :key="link.to">
                <SidebarMenuButton
                  as-child
                  :is-active="route.path === link.to && (link.to !== '/files' || !favourites.includes(currentFolder ?? ''))"
                  :tooltip="link.label"
                >
                  <RouterLink :to="link.to">
                    <component :is="link.icon" />
                    <span>{{ link.label }}</span>
                  </RouterLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup v-if="favourites.length">
          <SidebarGroupLabel>Favourites</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem v-for="folder in favourites" :key="folder">
                <SidebarMenuButton as-child :is-active="currentFolder === folder" :tooltip="folder">
                  <RouterLink :to="{ path: '/files', query: { path: folder } }" :title="folder">
                    <FolderIcon />
                    <span>{{ label(folder) }}</span>
                  </RouterLink>
                </SidebarMenuButton>
                <SidebarMenuAction show-on-hover :aria-label="`Remove ${folder} from favourites`" @click="removeFavourite(folder)">
                  <XIcon />
                </SidebarMenuAction>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton as-child :is-active="route.path === '/settings'" tooltip="Settings">
              <RouterLink to="/settings">
                <SettingsIcon />
                <span>Settings</span>
              </RouterLink>
            </SidebarMenuButton>
            <SidebarMenuBadge v-if="updateAvailable">Update</SidebarMenuBadge>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Sign out" @click="signOut">
              <LogOutIcon />
              <span>Sign out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>

    <SidebarInset>
      <header class="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <SidebarTrigger class="-ml-1" />
        <Separator orientation="vertical" class="mr-2 h-4! self-center!" />
        <h1 class="min-w-0 truncate text-sm font-medium">{{ pageTitle }}</h1>
        <div class="ml-auto" />
        <JobsMenu />
        <Button
          variant="ghost"
          size="icon"
          :aria-label="mode === 'dark' ? 'Use light theme' : 'Use dark theme'"
          @click="mode = mode === 'dark' ? 'light' : 'dark'"
        >
          <SunIcon v-if="mode === 'dark'" />
          <MoonIcon v-else />
        </Button>
      </header>
      <main class="flex w-full min-w-0 flex-1 flex-col gap-3 p-4 md:p-5">
        <RouterView />
      </main>
    </SidebarInset>
  </SidebarProvider>
</template>

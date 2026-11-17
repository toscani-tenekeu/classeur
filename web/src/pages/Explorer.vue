<script setup lang="ts">
import {
  ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon, ClipboardPasteIcon, CopyIcon, DownloadIcon, EllipsisIcon,
  FilePlusIcon, FolderPlusIcon, GlobeIcon, LayoutGridIcon, ListIcon, LockIcon, PencilLineIcon, PlusIcon, RefreshCwIcon,
  ScissorsIcon, SearchIcon, StarIcon, Trash2Icon, UploadIcon, XIcon,
} from '@lucide/vue'
import { useLocalStorage } from '@vueuse/core'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import ArchiveDialog from '@/components/explorer/ArchiveDialog.vue'
import CompressDialog from '@/components/explorer/CompressDialog.vue'
import DeleteDialog from '@/components/explorer/DeleteDialog.vue'
import DetailsSheet from '@/components/explorer/DetailsSheet.vue'
import FetchDialog from '@/components/explorer/FetchDialog.vue'
import NameDialog from '@/components/explorer/NameDialog.vue'
import PermissionsDialog from '@/components/explorer/PermissionsDialog.vue'
import PreviewDialog from '@/components/explorer/PreviewDialog.vue'
import TransferDialog from '@/components/explorer/TransferDialog.vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Breadcrumb, BreadcrumbEllipsis, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { clipboard, setClipboard } from '@/composables/useClipboard'
import { addFavourite, favourites, removeFavourite } from '@/composables/useFavourites'
import { onJobFinished } from '@/composables/useJobs'
import { type Conflict, enqueue, filesFromDrop } from '@/composables/useUploads'
import { api, messageOf, post } from '@/lib/api'
import {
  downloadUrl, iconFor, nameOf, type Opener, openerFor, parentOf, rawUrl, symbolic, zipUrl,
} from '@/lib/files'
import { bytes, dateTime } from '@/lib/format'
import type { Entry, Listing, Search, SearchResult } from '@/lib/types'

const route = useRoute()
const router = useRouter()

const path = computed(() => {
  const value = route.query.path
  return typeof value === 'string' && value.startsWith('/') ? value : '/'
})

// ---- Listing ------------------------------------------------------------------------

const listing = ref<Listing | null>(null)
const error = ref('')
const loading = ref(false)
let request = 0

async function load(keepSelection = false) {
  const current = ++request
  loading.value = true
  try {
    const result = await api<Listing>(`/fs/list?path=${encodeURIComponent(path.value)}`)
    if (current !== request) return
    listing.value = result
    error.value = ''
    if (!keepSelection) selected.value = new Set()
    else selected.value = new Set([...selected.value].filter((item) => result.entries.some((entry) => entry.path === item)))
  } catch (failure) {
    if (current === request) {
      error.value = messageOf(failure)
      listing.value = null
    }
  } finally {
    if (current === request) loading.value = false
  }
}

watch(path, () => {
  filter.value = ''
  searchOpen.value = false
  results.value = null
  void load()
})

const stopListening = onJobFinished((folders) => {
  if (folders.includes(path.value)) void load(true)
})

function go(target: string) {
  if (target !== path.value) void router.push({ path: '/files', query: { path: target } })
}

// ---- View options -------------------------------------------------------------------

const view = useLocalStorage<'list' | 'grid'>('classeur.view', 'list')
const showHidden = useLocalStorage('classeur.hidden', false)
const sortKey = useLocalStorage<'name' | 'size' | 'modified' | 'mode' | 'owner'>('classeur.sort', 'name')
const sortDesc = useLocalStorage('classeur.sortDesc', false)
const filter = ref('')

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const isFolder = (entry: Entry) => entry.kind === 'directory' || (entry.kind === 'link' && entry.targetKind === 'directory')

const visible = computed(() => {
  const term = filter.value.trim().toLowerCase()
  const list = (listing.value?.entries ?? []).filter(
    (entry) => (showHidden.value || !entry.hidden) && (!term || entry.name.toLowerCase().includes(term)),
  )
  const direction = sortDesc.value ? -1 : 1
  return list.sort((a, b) => {
    if (isFolder(a) !== isFolder(b)) return isFolder(a) ? -1 : 1
    let order = 0
    if (sortKey.value === 'size') order = a.size - b.size
    else if (sortKey.value === 'modified') order = a.modified - b.modified
    else if (sortKey.value === 'mode') order = a.mode.localeCompare(b.mode)
    else if (sortKey.value === 'owner') order = a.owner.localeCompare(b.owner)
    return (order || collator.compare(a.name, b.name)) * direction
  })
})

const hiddenCount = computed(() => (showHidden.value ? 0 : (listing.value?.entries ?? []).filter((entry) => entry.hidden).length))

function sortBy(key: typeof sortKey.value) {
  if (sortKey.value === key) sortDesc.value = !sortDesc.value
  else {
    sortKey.value = key
    sortDesc.value = key === 'size' || key === 'modified'
  }
}

const allCrumbs = computed(() => {
  const parts = path.value.split('/').filter(Boolean)
  return parts.map((name, index) => ({ name, path: `/${parts.slice(0, index + 1).join('/')}` }))
})
/** Deep paths keep the first folder and the last three; the middle folds into “…”. */
const crumbs = computed(() =>
  allCrumbs.value.length > 5 ? [allCrumbs.value[0]!, null, ...allCrumbs.value.slice(-3)] : allCrumbs.value,
)
const editingPath = ref(false)
const typedPath = ref('')

function startEditingPath() {
  typedPath.value = path.value
  editingPath.value = true
  setTimeout(() => (document.getElementById('path-input') as HTMLInputElement | null)?.select(), 0)
}

function submitPath() {
  const value = typedPath.value.trim()
  editingPath.value = false
  if (value.startsWith('/')) go(value.length > 1 ? value.replace(/\/+$/, '') : '/')
}

const isFavourite = computed(() => favourites.value.includes(path.value))
const readOnly = computed(() => !listing.value?.writable)

// ---- Selection ------------------------------------------------------------------------

const selected = ref(new Set<string>())
let anchor = -1

const selectedEntries = computed(() => visible.value.filter((entry) => selected.value.has(entry.path)))
const selectedSize = computed(() => selectedEntries.value.reduce((sum, entry) => sum + entry.size, 0))
const allSelected = computed(() => visible.value.length > 0 && selectedEntries.value.length === visible.value.length)

function select(entry: Entry, event?: MouseEvent | KeyboardEvent) {
  const index = visible.value.indexOf(entry)
  const next = new Set(event && (event.ctrlKey || event.metaKey) ? selected.value : [])
  if (event?.shiftKey && anchor >= 0) {
    const [from, to] = [Math.min(anchor, index), Math.max(anchor, index)]
    for (const item of visible.value.slice(from, to + 1)) next.add(item.path)
  } else if (event && (event.ctrlKey || event.metaKey) && selected.value.has(entry.path)) {
    next.delete(entry.path)
    anchor = index
  } else {
    next.add(entry.path)
    anchor = index
  }
  selected.value = next
}

function toggleOne(entry: Entry, on: boolean) {
  const next = new Set(selected.value)
  if (on) next.add(entry.path)
  else next.delete(entry.path)
  selected.value = next
  anchor = visible.value.indexOf(entry)
}

function toggleAll() {
  selected.value = allSelected.value ? new Set() : new Set(visible.value.map((entry) => entry.path))
}

// ---- Opening --------------------------------------------------------------------------

const preview = ref<{ entry: Entry; opener: Opener } | null>(null)
const previewOpen = ref(false)
const archivePath = ref<string | null>(null)
const archiveOpen = ref(false)
const detailsPath = ref<string | null>(null)
const detailsOpen = ref(false)

function openEntry(entry: Entry) {
  const opener = openerFor(entry)
  if (opener === 'folder') return go(entry.path)
  if (opener === 'text') return void router.push({ path: '/edit', query: { path: entry.path } })
  if (opener === 'archive') {
    archivePath.value = entry.path
    archiveOpen.value = true
    return
  }
  if (opener === 'other') return showDetails(entry.path)
  preview.value = { entry, opener }
  previewOpen.value = true
}

function previewAsText(entry: Entry) {
  preview.value = { entry, opener: 'text' }
  previewOpen.value = true
}

function showDetails(target: string) {
  detailsPath.value = target
  detailsOpen.value = true
}

function download(entries: Entry[]) {
  const link = document.createElement('a')
  link.href = entries.length === 1 && entries[0]!.kind === 'file' ? downloadUrl(entries[0]!.path) : zipUrl(entries.map((entry) => entry.path))
  link.download = ''
  document.body.append(link)
  link.click()
  link.remove()
}

async function copyPath(entries: Entry[]) {
  try {
    await navigator.clipboard.writeText(entries.map((entry) => entry.path).join('\n'))
    toast.success(entries.length === 1 ? 'Path copied.' : 'Paths copied.')
  } catch {
    toast.error('The browser did not allow copying.')
  }
}

// ---- Changing ---------------------------------------------------------------------------

const nameDialog = ref<{
  title: string
  description: string
  label: string
  initial: string
  confirm: string
  selectStem?: boolean
  submit: (name: string) => Promise<void>
} | null>(null)
const nameOpen = ref(false)

function askName(options: NonNullable<typeof nameDialog.value>) {
  nameDialog.value = options
  nameOpen.value = true
}

function newFolder() {
  askName({
    title: 'New folder',
    description: `In ${path.value}`,
    label: 'Name',
    initial: 'New folder',
    confirm: 'Create',
    submit: async (name) => {
      await post('/fs/folder', { parent: path.value, name })
      await load()
    },
  })
}

function newFile() {
  askName({
    title: 'New file',
    description: `An empty file in ${path.value}. It opens in the editor.`,
    label: 'Name',
    initial: 'new-file.txt',
    confirm: 'Create',
    selectStem: true,
    submit: async (name) => {
      const created = await post<{ path: string }>('/fs/file', { parent: path.value, name })
      void router.push({ path: '/edit', query: { path: created.path } })
    },
  })
}

function renameEntry(entry: Entry) {
  askName({
    title: `Rename ${entry.name}`,
    description: 'Programs or links that use the old name will no longer find it.',
    label: 'New name',
    initial: entry.name,
    confirm: 'Rename',
    selectStem: entry.kind !== 'directory',
    submit: async (name) => {
      await post('/fs/rename', { path: entry.path, name })
      await load()
    },
  })
}

function linkEntry(entry: Entry) {
  askName({
    title: `Create a link to ${entry.name}`,
    description: `A shortcut in ${path.value} that points to ${entry.path}. Removing the link later leaves the original alone.`,
    label: 'Link name',
    initial: `${entry.name} link`,
    confirm: 'Create link',
    submit: async (name) => {
      await post('/fs/link', { target: entry.path, parent: path.value, name })
      await load(true)
    },
  })
}

const transfer = ref<{ op: 'copy' | 'move'; paths: string[]; destination: string } | null>(null)
const transferOpen = ref(false)

function askTransfer(op: 'copy' | 'move', paths: string[], destination: string) {
  if (!paths.length) return
  if (op === 'move' && paths.every((item) => parentOf(item) === destination)) return
  transfer.value = { op, paths, destination }
  transferOpen.value = true
}

function paste(destination = path.value) {
  if (!clipboard.value) return
  askTransfer(clipboard.value.op, clipboard.value.paths, destination)
}

function afterTransfer() {
  if (transfer.value?.op === 'move' && clipboard.value?.op === 'move') clipboard.value = null
}

function cut(entries: Entry[]) {
  setClipboard('move', entries.map((entry) => entry.path))
  toast(`${entries.length === 1 ? entries[0]!.name : `${entries.length} items`} ready to move. Open the destination and paste.`)
}

function copy(entries: Entry[]) {
  setClipboard('copy', entries.map((entry) => entry.path))
  toast(`${entries.length === 1 ? entries[0]!.name : `${entries.length} items`} ready to copy. Open the destination and paste.`)
}

const deletePaths = ref<string[]>([])
const deleteOpen = ref(false)
function askDelete(entries: Entry[]) {
  if (!entries.length) return
  deletePaths.value = entries.map((entry) => entry.path)
  deleteOpen.value = true
}

const permissionEntries = ref<Entry[]>([])
const permissionsOpen = ref(false)
function askPermissions(entries: Entry[]) {
  permissionEntries.value = entries
  permissionsOpen.value = true
}

const compressPaths = ref<string[]>([])
const compressOpen = ref(false)
function askCompress(entries: Entry[]) {
  compressPaths.value = entries.map((entry) => entry.path)
  compressOpen.value = true
}

const fetchOpen = ref(false)

// ---- Uploads -------------------------------------------------------------------------------

const fileInput = ref<HTMLInputElement | null>(null)
const folderInput = ref<HTMLInputElement | null>(null)
const uploadConflict = ref<Conflict>('rename')

function startUpload(dir: string, files: { file: File; relative: string }[]) {
  if (!files.length) return
  enqueue(dir, files, uploadConflict.value, (done) => {
    if (done === path.value || parentOf(done) === path.value) void load(true)
  })
  toast(`Uploading ${files.length === 1 ? files[0]!.relative : `${files.length} files`}…`)
}

function pickedFiles(event: Event, keepFolders: boolean) {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])].map((file) => ({
    file,
    relative: keepFolders && file.webkitRelativePath ? file.webkitRelativePath : file.name,
  }))
  input.value = ''
  startUpload(path.value, files)
}

// ---- Drag and drop -----------------------------------------------------------------------

const DRAG_TYPE = 'application/x-classeur-paths'
const dropTarget = ref<string | null>(null)
const draggingFiles = ref(false)

function dragStart(entry: Entry, event: DragEvent) {
  if (!selected.value.has(entry.path)) select(entry)
  const paths = selectedEntries.value.map((item) => item.path)
  event.dataTransfer?.setData(DRAG_TYPE, JSON.stringify(paths))
  event.dataTransfer?.setData('text/plain', paths.join('\n'))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copyMove'
}

const carries = (event: DragEvent, type: string) => [...(event.dataTransfer?.types ?? [])].includes(type)

function dragOverFolder(entry: Entry, event: DragEvent) {
  if (!isFolder(entry) || (!carries(event, DRAG_TYPE) && !carries(event, 'Files'))) return
  if (carries(event, DRAG_TYPE) && selected.value.has(entry.path)) return
  event.preventDefault()
  event.stopPropagation()
  dropTarget.value = entry.path
  if (event.dataTransfer) event.dataTransfer.dropEffect = event.ctrlKey || event.altKey ? 'copy' : 'move'
}

async function dropOnFolder(entry: Entry, event: DragEvent) {
  dropTarget.value = null
  draggingFiles.value = false
  if (!isFolder(entry)) return
  event.preventDefault()
  event.stopPropagation()
  const internal = event.dataTransfer?.getData(DRAG_TYPE)
  if (internal) {
    const paths = (JSON.parse(internal) as string[]).filter((item) => item !== entry.path)
    askTransfer(event.ctrlKey || event.altKey ? 'copy' : 'move', paths, entry.path)
  } else if (event.dataTransfer) {
    startUpload(entry.path, await filesFromDrop(event.dataTransfer))
  }
}

function dragOverArea(event: DragEvent) {
  if (!carries(event, 'Files') || readOnly.value) return
  event.preventDefault()
  draggingFiles.value = true
}

async function dropOnArea(event: DragEvent) {
  draggingFiles.value = false
  if (!carries(event, 'Files') || !event.dataTransfer || readOnly.value) return
  event.preventDefault()
  startUpload(path.value, await filesFromDrop(event.dataTransfer))
}

// ---- Context menu ---------------------------------------------------------------------------

const menuEntries = ref<Entry[]>([])

function onContextMenu(event: MouseEvent) {
  const row = (event.target as HTMLElement).closest<HTMLElement>('[data-path]')
  const entry = row ? visible.value.find((item) => item.path === row.dataset.path) : undefined
  if (!entry) {
    selected.value = new Set()
    menuEntries.value = []
    return
  }
  if (!selected.value.has(entry.path)) select(entry)
  menuEntries.value = selectedEntries.value
}

const single = computed(() => (menuEntries.value.length === 1 ? menuEntries.value[0]! : null))

// ---- Search ----------------------------------------------------------------------------------

const searchOpen = ref(false)
const searching = ref(false)
const results = ref<Search | null>(null)
const query = ref({ text: '', ext: '', size: '0', age: '0', kind: 'any' })

async function runSearch() {
  searching.value = true
  const [days, older] = query.value.age.startsWith('-') ? [query.value.age.slice(1), '1'] : [query.value.age, '0']
  const params = new URLSearchParams({
    path: path.value,
    q: query.value.text,
    ext: query.value.ext,
    min: String(Number(query.value.size) * 1024 * 1024),
    days,
    older,
    kind: query.value.kind,
  })
  try {
    results.value = await api<Search>(`/fs/search?${params}`)
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  searching.value = false
}

function closeSearch() {
  searchOpen.value = false
  results.value = null
}

function openResult(result: SearchResult) {
  const entry = { ...result, target: null, targetKind: null, mode: '', group: '', hidden: false } as Entry
  if (result.kind === 'directory') go(result.path)
  else openEntry(entry)
}

function revealResult(result: SearchResult) {
  closeSearch()
  go(parentOf(result.path))
  const stop = watch(listing, (value) => {
    if (value?.path === parentOf(result.path)) {
      selected.value = new Set([result.path])
      stop()
    }
  })
}

// ---- Keyboard -------------------------------------------------------------------------------

function onKey(event: KeyboardEvent) {
  const target = event.target as HTMLElement
  if (target.closest('input, textarea, select, [contenteditable="true"]')) return
  if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return
  const mod = event.ctrlKey || event.metaKey
  const chosen = selectedEntries.value

  if (mod && event.key.toLowerCase() === 'a') {
    event.preventDefault()
    selected.value = new Set(visible.value.map((entry) => entry.path))
  } else if (mod && event.key.toLowerCase() === 'c' && chosen.length) copy(chosen)
  else if (mod && event.key.toLowerCase() === 'x' && chosen.length) cut(chosen)
  else if (mod && event.key.toLowerCase() === 'v' && clipboard.value && !readOnly.value) paste()
  else if (event.key === 'Delete' && chosen.length) askDelete(chosen)
  else if (event.key === 'F2' && chosen.length === 1) renameEntry(chosen[0]!)
  else if (event.key === 'Enter' && chosen.length === 1) openEntry(chosen[0]!)
  else if (event.key === 'Escape') selected.value = new Set()
  else if ((event.key === 'Backspace' || (event.altKey && event.key === 'ArrowUp')) && listing.value?.parent) {
    event.preventDefault()
    go(listing.value.parent)
  } else if (event.altKey && event.key === 'ArrowLeft') router.back()
  else if (event.altKey && event.key === 'ArrowRight') router.forward()
  else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const list = visible.value
    if (!list.length) return
    const current = chosen.length ? list.indexOf(chosen.at(-1)!) : -1
    const next = Math.min(list.length - 1, Math.max(0, current + (event.key === 'ArrowDown' ? 1 : -1)))
    select(list[next]!, event.shiftKey ? event : undefined)
    document.querySelector(`[data-path="${CSS.escape(list[next]!.path)}"]`)?.scrollIntoView({ block: 'nearest' })
  }
}

onMounted(() => {
  void load()
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  stopListening()
})

const thumbnail = (entry: Entry) => openerFor(entry) === 'image' && entry.size < 15 * 1024 * 1024
const SORT_COLUMNS = [
  { key: 'size', label: 'Size', class: 'w-24 text-right' },
  { key: 'modified', label: 'Modified', class: 'w-40' },
  { key: 'mode', label: 'Permissions', class: 'w-32' },
  { key: 'owner', label: 'Owner', class: 'w-32' },
] as const
</script>

<template>
  <!-- Toolbar -->
  <div class="flex flex-wrap items-center gap-2">
    <ButtonGroup>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button variant="outline" size="icon" aria-label="Back" @click="router.back()"><ArrowLeftIcon /></Button>
        </TooltipTrigger>
        <TooltipContent>Back <span class="opacity-60">Alt+←</span></TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button variant="outline" size="icon" aria-label="Forward" @click="router.forward()"><ArrowRightIcon /></Button>
        </TooltipTrigger>
        <TooltipContent>Forward <span class="opacity-60">Alt+→</span></TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button variant="outline" size="icon" aria-label="Up one folder" :disabled="!listing?.parent" @click="listing?.parent && go(listing.parent)">
            <ArrowUpIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Up one folder <span class="opacity-60">Backspace</span></TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button variant="outline" size="icon" aria-label="Refresh" @click="load(true)">
            <Spinner v-if="loading" />
            <RefreshCwIcon v-else />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Refresh</TooltipContent>
      </Tooltip>
    </ButtonGroup>

    <!-- Path bar -->
    <div class="min-w-0 flex-1">
      <form v-if="editingPath" @submit.prevent="submitPath">
        <Input
          id="path-input"
          v-model="typedPath"
          class="font-mono"
          aria-label="Folder path"
          autocomplete="off"
          spellcheck="false"
          @blur="editingPath = false"
          @keydown.escape="editingPath = false"
        />
      </form>
      <div
        v-else
        class="border-input dark:bg-input/30 flex h-9 cursor-text items-center overflow-x-auto rounded-md border px-3 shadow-xs"
        title="Click to type a path"
        @click.self="startEditingPath"
      >
        <Breadcrumb class="shrink-0">
          <BreadcrumbList class="flex-nowrap">
            <BreadcrumbItem>
              <BreadcrumbPage v-if="!crumbs.length" class="font-mono">/</BreadcrumbPage>
              <BreadcrumbLink v-else as-child>
                <button type="button" class="font-mono" @click="go('/')">/</button>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <template v-for="(crumb, index) in crumbs" :key="crumb?.path ?? 'more'">
              <BreadcrumbSeparator v-if="index > 0" />
              <BreadcrumbItem v-if="!crumb">
                <button type="button" aria-label="Show the full path" @click="startEditingPath"><BreadcrumbEllipsis class="size-4" /></button>
              </BreadcrumbItem>
              <BreadcrumbItem v-else>
                <BreadcrumbPage v-if="index === crumbs.length - 1" class="whitespace-nowrap">{{ crumb.name }}</BreadcrumbPage>
                <BreadcrumbLink v-else as-child>
                  <button type="button" class="whitespace-nowrap" @click="go(crumb.path)">{{ crumb.name }}</button>
                </BreadcrumbLink>
              </BreadcrumbItem>
            </template>
          </BreadcrumbList>
        </Breadcrumb>
        <span class="h-full min-w-8 flex-1" @click="startEditingPath" />
        <Button
          variant="ghost"
          size="icon-xs"
          :aria-label="isFavourite ? 'Remove from favourites' : 'Add to favourites'"
          @click="isFavourite ? removeFavourite(path) : addFavourite(path)"
        >
          <StarIcon :class="isFavourite ? 'fill-current' : ''" />
        </Button>
      </div>
    </div>

    <div class="relative w-44">
      <SearchIcon class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
      <Input v-model="filter" class="pl-8" placeholder="Filter this folder" aria-label="Filter this folder" />
    </div>
    <Button variant="outline" :aria-pressed="searchOpen" @click="searchOpen ? closeSearch() : (searchOpen = true)">
      <SearchIcon data-icon="inline-start" />
      Search
    </Button>
  </div>

  <div class="flex flex-wrap items-center gap-2">
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button :disabled="readOnly">
          <PlusIcon data-icon="inline-start" />
          New
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem @select="newFolder"><FolderPlusIcon /> Folder</DropdownMenuItem>
        <DropdownMenuItem @select="newFile"><FilePlusIcon /> Text file</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem @select="fetchOpen = true"><GlobeIcon /> Download from a web address</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button variant="outline" :disabled="readOnly">
          <UploadIcon data-icon="inline-start" />
          Upload
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-64">
        <DropdownMenuItem @select="fileInput?.click()">Files</DropdownMenuItem>
        <DropdownMenuItem @select="folderInput?.click()">A whole folder</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          :model-value="uploadConflict === 'overwrite'"
          @update:model-value="(on) => (uploadConflict = on ? 'overwrite' : 'rename')"
        >
          Replace files with the same name
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <input ref="fileInput" type="file" multiple class="hidden" @change="pickedFiles($event, false)" />
    <input ref="folderInput" type="file" webkitdirectory class="hidden" @change="pickedFiles($event, true)" />
    <Button v-if="clipboard" variant="outline" :disabled="readOnly" @click="paste()">
      <ClipboardPasteIcon data-icon="inline-start" />
      Paste {{ clipboard.paths.length }}
      <XIcon class="ml-1 opacity-60" @click.stop="clipboard = null" />
    </Button>

    <template v-if="selectedEntries.length">
      <span class="text-muted-foreground ml-2 text-sm">
        {{ selectedEntries.length }} selected<template v-if="selectedSize">, {{ bytes(selectedSize) }}</template>
      </span>
      <ButtonGroup>
        <Button variant="outline" size="sm" @click="copy(selectedEntries)"><CopyIcon data-icon="inline-start" /> Copy</Button>
        <Button variant="outline" size="sm" @click="cut(selectedEntries)"><ScissorsIcon data-icon="inline-start" /> Cut</Button>
        <Button variant="outline" size="sm" @click="download(selectedEntries)"><DownloadIcon data-icon="inline-start" /> Download</Button>
      </ButtonGroup>
      <Button variant="outline" size="sm" @click="askDelete(selectedEntries)"><Trash2Icon data-icon="inline-start" /> Delete</Button>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="outline" size="icon-sm" aria-label="More actions"><EllipsisIcon /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem v-if="selectedEntries.length === 1" @select="renameEntry(selectedEntries[0]!)">Rename</DropdownMenuItem>
          <DropdownMenuItem @select="askCompress(selectedEntries)">Compress</DropdownMenuItem>
          <DropdownMenuItem @select="askPermissions(selectedEntries)">Permissions and owner</DropdownMenuItem>
          <DropdownMenuItem @select="copyPath(selectedEntries)">Copy path</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="ghost" size="icon-sm" aria-label="Clear selection" @click="selected = new Set()"><XIcon /></Button>
    </template>

    <div class="ml-auto flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="sm">View</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuCheckboxItem v-model="showHidden">Show hidden files</DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem @select="showDetails(path)">Folder details</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ToggleGroup v-model="view" type="single" variant="outline" size="sm">
        <ToggleGroupItem value="list" aria-label="List"><ListIcon /></ToggleGroupItem>
        <ToggleGroupItem value="grid" aria-label="Grid"><LayoutGridIcon /></ToggleGroupItem>
      </ToggleGroup>
    </div>
  </div>

  <!-- Search -->
  <Card v-if="searchOpen" class="py-4">
    <CardContent class="px-4">
      <form class="flex flex-wrap items-end gap-3" @submit.prevent="runSearch">
        <Field class="w-56">
          <FieldLabel for="search-text">Name</FieldLabel>
          <Input id="search-text" v-model="query.text" placeholder="report or *.bak" autocomplete="off" />
        </Field>
        <Field class="w-40">
          <FieldLabel for="search-ext">Extensions</FieldLabel>
          <Input id="search-ext" v-model="query.ext" placeholder="zip, log" autocomplete="off" />
        </Field>
        <Field class="w-36">
          <FieldLabel for="search-size">Size</FieldLabel>
          <Select v-model="query.size">
            <SelectTrigger id="search-size"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="0">Any size</SelectItem>
              <SelectItem value="1">1 MB or more</SelectItem>
              <SelectItem value="100">100 MB or more</SelectItem>
              <SelectItem value="1024">1 GB or more</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field class="w-44">
          <FieldLabel for="search-age">Modified</FieldLabel>
          <Select v-model="query.age">
            <SelectTrigger id="search-age"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="0">Any time</SelectItem>
              <SelectItem value="1">Today</SelectItem>
              <SelectItem value="7">In the last 7 days</SelectItem>
              <SelectItem value="30">In the last 30 days</SelectItem>
              <SelectItem value="-90">More than 90 days ago</SelectItem>
              <SelectItem value="-365">More than a year ago</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field class="w-32">
          <FieldLabel for="search-kind">Type</FieldLabel>
          <Select v-model="query.kind">
            <SelectTrigger id="search-kind"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Anything</SelectItem>
              <SelectItem value="file">Files</SelectItem>
              <SelectItem value="directory">Folders</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Button type="submit" :disabled="searching">
          <Spinner v-if="searching" data-icon="inline-start" />
          Search in {{ nameOf(path) || '/' }}
        </Button>
        <Button type="button" variant="ghost" @click="closeSearch">Close</Button>
      </form>
    </CardContent>
  </Card>

  <Alert v-if="listing?.protected">
    <LockIcon />
    <AlertDescription>{{ listing.protected }} You can look and download, not change.</AlertDescription>
  </Alert>
  <Alert v-if="error" variant="destructive">
    <AlertDescription>{{ error }}</AlertDescription>
  </Alert>

  <!-- Search results -->
  <Card v-if="results" class="py-0">
    <CardContent class="px-0">
      <div class="text-muted-foreground border-b px-4 py-3 text-sm">
        {{ results.results.length }} found in {{ results.path }}
        <template v-if="results.truncated">(stopped early: narrow the search to see everything)</template>
      </div>
      <Table v-if="results.results.length">
        <TableHeader>
          <TableRow>
            <TableHead class="pl-4">Name</TableHead>
            <TableHead class="text-right">Size</TableHead>
            <TableHead>Modified</TableHead>
            <TableHead class="w-28 pr-4" />
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="result in results.results" :key="result.path" class="cursor-default" @dblclick="openResult(result)">
            <TableCell class="w-full max-w-0 pl-4">
              <span class="flex items-center gap-2">
                <component :is="iconFor({ ...result, targetKind: null })" class="text-muted-foreground size-4 shrink-0" />
                <span class="min-w-0">
                  <span class="block truncate font-medium">{{ result.name }}</span>
                  <span class="text-muted-foreground block truncate font-mono text-xs">{{ parentOf(result.path) }}</span>
                </span>
              </span>
            </TableCell>
            <TableCell class="text-right tabular-nums">{{ result.kind === 'directory' ? '' : bytes(result.size) }}</TableCell>
            <TableCell class="text-muted-foreground whitespace-nowrap">{{ dateTime(result.modified) }}</TableCell>
            <TableCell class="pr-4 text-right">
              <Button variant="outline" size="xs" @click="revealResult(result)">Show in folder</Button>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <Empty v-else>
        <EmptyHeader>
          <EmptyTitle>Nothing found</EmptyTitle>
          <EmptyDescription>Try a shorter name or fewer conditions.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </CardContent>
  </Card>

  <!-- Listing -->
  <ContextMenu v-else>
    <ContextMenuTrigger as-child>
      <Card
        class="relative min-h-80 flex-1 gap-0 py-0"
        :class="draggingFiles ? 'ring-primary ring-2' : ''"
        @contextmenu="onContextMenu"
        @dragover="dragOverArea"
        @dragleave.self="draggingFiles = false"
        @drop="dropOnArea"
        @click.self="selected = new Set()"
      >
        <div v-if="!listing && loading" class="flex flex-col gap-2 p-4">
          <Skeleton v-for="index in 10" :key="index" class="h-9" />
        </div>

        <template v-else-if="listing">
          <Empty v-if="!visible.length" class="flex-1">
            <EmptyHeader>
              <EmptyTitle>{{ filter ? 'Nothing matches' : 'This folder is empty' }}</EmptyTitle>
              <EmptyDescription>
                <template v-if="filter">No name contains “{{ filter }}”.</template>
                <template v-else-if="hiddenCount">{{ hiddenCount }} hidden {{ hiddenCount === 1 ? 'item' : 'items' }}. Turn on “Show hidden files” in View.</template>
                <template v-else-if="!readOnly">Drop files here to upload them, or use New.</template>
              </EmptyDescription>
            </EmptyHeader>
          </Empty>

          <Table v-else-if="view === 'list'">
            <TableHeader class="bg-card sticky top-0 z-10">
              <TableRow>
                <TableHead class="w-10 pl-4">
                  <Checkbox :model-value="allSelected" aria-label="Select all" @update:model-value="toggleAll" />
                </TableHead>
                <TableHead>
                  <button type="button" class="flex items-center gap-1" @click="sortBy('name')">
                    Name
                    <ArrowDownIcon v-if="sortKey === 'name'" class="size-3.5" :class="sortDesc ? '' : 'rotate-180'" />
                  </button>
                </TableHead>
                <TableHead v-for="column in SORT_COLUMNS" :key="column.key" :class="column.class">
                  <button
                    type="button"
                    class="flex items-center gap-1"
                    :class="column.key === 'size' ? 'ml-auto' : ''"
                    @click="sortBy(column.key)"
                  >
                    {{ column.label }}
                    <ArrowDownIcon v-if="sortKey === column.key" class="size-3.5" :class="sortDesc ? '' : 'rotate-180'" />
                  </button>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow
                v-for="entry in visible"
                :key="entry.path"
                :data-path="entry.path"
                :data-state="selected.has(entry.path) ? 'selected' : undefined"
                class="cursor-default select-none"
                :class="dropTarget === entry.path ? 'bg-accent outline-primary outline-2 -outline-offset-2' : ''"
                draggable="true"
                @click="select(entry, $event)"
                @dblclick="openEntry(entry)"
                @dragstart="dragStart(entry, $event)"
                @dragover="dragOverFolder(entry, $event)"
                @dragleave="dropTarget = dropTarget === entry.path ? null : dropTarget"
                @drop="dropOnFolder(entry, $event)"
              >
                <TableCell class="pl-4" @click.stop>
                  <Checkbox
                    :model-value="selected.has(entry.path)"
                    :aria-label="`Select ${entry.name}`"
                    @update:model-value="(on) => toggleOne(entry, on === true)"
                  />
                </TableCell>
                <TableCell class="w-full max-w-0">
                  <span class="flex items-center gap-2">
                    <component
                      :is="iconFor(entry)"
                      class="size-4 shrink-0"
                      :class="isFolder(entry) ? 'text-foreground' : 'text-muted-foreground'"
                    />
                    <span class="truncate" :class="entry.hidden ? 'text-muted-foreground' : ''">{{ entry.name }}</span>
                    <span v-if="entry.target" class="text-muted-foreground truncate font-mono text-xs">→ {{ entry.target }}</span>
                  </span>
                </TableCell>
                <TableCell class="text-right tabular-nums">{{ isFolder(entry) ? '' : bytes(entry.size) }}</TableCell>
                <TableCell class="text-muted-foreground whitespace-nowrap">{{ dateTime(entry.modified) }}</TableCell>
                <TableCell class="text-muted-foreground font-mono text-xs" :title="entry.mode">{{ symbolic(entry.mode) }}</TableCell>
                <TableCell class="text-muted-foreground max-w-32 truncate">{{ entry.owner }}</TableCell>
              </TableRow>
            </TableBody>
          </Table>

          <div v-else class="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2 p-3" @click.self="selected = new Set()">
            <div
              v-for="entry in visible"
              :key="entry.path"
              :data-path="entry.path"
              class="hover:bg-muted/60 flex cursor-default flex-col items-center gap-2 rounded-lg border border-transparent p-2 text-center select-none"
              :class="[
                selected.has(entry.path) ? 'bg-muted border-border' : '',
                dropTarget === entry.path ? 'bg-accent outline-primary outline-2' : '',
              ]"
              draggable="true"
              @click="select(entry, $event)"
              @dblclick="openEntry(entry)"
              @dragstart="dragStart(entry, $event)"
              @dragover="dragOverFolder(entry, $event)"
              @dragleave="dropTarget = dropTarget === entry.path ? null : dropTarget"
              @drop="dropOnFolder(entry, $event)"
            >
              <div class="bg-muted/50 flex aspect-square w-full items-center justify-center overflow-hidden rounded-md">
                <img v-if="thumbnail(entry)" :src="rawUrl(entry.path)" :alt="entry.name" loading="lazy" class="size-full object-cover" />
                <component :is="iconFor(entry)" v-else class="text-muted-foreground size-10" stroke-width="1.25" />
              </div>
              <span class="line-clamp-2 w-full text-xs break-all" :class="entry.hidden ? 'text-muted-foreground' : ''">{{ entry.name }}</span>
            </div>
          </div>
        </template>

        <div
          v-if="listing"
          class="text-muted-foreground bg-card sticky bottom-0 mt-auto flex justify-between gap-4 rounded-b-xl border-t px-4 py-2 text-xs"
        >
          <span>
            {{ visible.length }} {{ visible.length === 1 ? 'item' : 'items' }}<template v-if="hiddenCount">, {{ hiddenCount }} hidden</template>
          </span>
          <span v-if="!readOnly">Drop files to upload · Ctrl-drag to copy</span>
        </div>
      </Card>
    </ContextMenuTrigger>

    <ContextMenuContent class="w-60">
      <template v-if="menuEntries.length">
        <template v-if="single">
          <ContextMenuItem @select="openEntry(single)">Open</ContextMenuItem>
          <ContextMenuItem v-if="single.kind === 'file' && openerFor(single) !== 'text'" @select="previewAsText(single)">
            View as text
          </ContextMenuItem>
          <ContextMenuItem v-if="single.kind === 'file'" @select="router.push({ path: '/edit', query: { path: single.path } })">
            <PencilLineIcon /> Edit as text
          </ContextMenuItem>
          <ContextMenuSeparator />
        </template>
        <ContextMenuItem @select="copy(menuEntries)">Copy <ContextMenuShortcut>Ctrl+C</ContextMenuShortcut></ContextMenuItem>
        <ContextMenuItem @select="cut(menuEntries)">Cut <ContextMenuShortcut>Ctrl+X</ContextMenuShortcut></ContextMenuItem>
        <ContextMenuItem v-if="single && isFolder(single) && clipboard" @select="paste(single.path)">Paste into this folder</ContextMenuItem>
        <ContextMenuItem @select="download(menuEntries)">
          {{ single?.kind === 'file' ? 'Download' : 'Download as zip' }}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem v-if="single" @select="renameEntry(single)">Rename <ContextMenuShortcut>F2</ContextMenuShortcut></ContextMenuItem>
        <ContextMenuItem @select="askCompress(menuEntries)">Compress</ContextMenuItem>
        <ContextMenuItem v-if="single && openerFor(single) === 'archive'" @select="openEntry(single)">Look inside and extract</ContextMenuItem>
        <ContextMenuItem v-if="single && !readOnly" @select="linkEntry(single)">Create a link here</ContextMenuItem>
        <ContextMenuItem @select="askPermissions(menuEntries)">Permissions and owner</ContextMenuItem>
        <ContextMenuItem v-if="single && isFolder(single)" @select="addFavourite(single.path)">Add to favourites</ContextMenuItem>
        <ContextMenuItem @select="copyPath(menuEntries)">Copy path</ContextMenuItem>
        <ContextMenuItem v-if="single" @select="showDetails(single.path)">Details</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" @select="askDelete(menuEntries)">Delete <ContextMenuShortcut>Del</ContextMenuShortcut></ContextMenuItem>
      </template>
      <template v-else>
        <ContextMenuItem :disabled="readOnly" @select="newFolder">New folder</ContextMenuItem>
        <ContextMenuItem :disabled="readOnly" @select="newFile">New text file</ContextMenuItem>
        <ContextMenuItem :disabled="readOnly || !clipboard" @select="paste()">Paste <ContextMenuShortcut>Ctrl+V</ContextMenuShortcut></ContextMenuItem>
        <ContextMenuItem :disabled="readOnly" @select="fileInput?.click()">Upload files</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem @select="selected = new Set(visible.map((entry) => entry.path))">Select all <ContextMenuShortcut>Ctrl+A</ContextMenuShortcut></ContextMenuItem>
        <ContextMenuItem @select="load(true)">Refresh</ContextMenuItem>
        <ContextMenuItem @select="showDetails(path)">Folder details</ContextMenuItem>
      </template>
    </ContextMenuContent>
  </ContextMenu>

  <NameDialog v-if="nameDialog" v-model:open="nameOpen" v-bind="nameDialog" />
  <TransferDialog v-if="transfer" v-model:open="transferOpen" v-bind="transfer" @started="afterTransfer" />
  <DeleteDialog v-model:open="deleteOpen" :paths="deletePaths" @done="load(true)" />
  <PermissionsDialog v-model:open="permissionsOpen" :entries="permissionEntries" />
  <CompressDialog v-model:open="compressOpen" :paths="compressPaths" />
  <FetchDialog v-model:open="fetchOpen" :dir="path" />
  <DetailsSheet v-model:open="detailsOpen" :path="detailsPath" />
  <ArchiveDialog v-model:open="archiveOpen" :path="archivePath" />
  <PreviewDialog
    v-model:open="previewOpen"
    :entry="preview?.entry ?? null"
    :opener="preview?.opener ?? 'other'"
    @edit="(target) => router.push({ path: '/edit', query: { path: target } })"
  />
</template>

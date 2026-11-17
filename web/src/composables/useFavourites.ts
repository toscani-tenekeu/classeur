import { ref } from 'vue'
import { toast } from 'vue-sonner'
import { api, messageOf } from '@/lib/api'

export const favourites = ref<string[]>([])

export async function loadFavourites() {
  favourites.value = await api<string[]>('/favourites').catch(() => favourites.value)
}

async function save(paths: string[]) {
  try {
    favourites.value = await api<string[]>('/favourites', { method: 'PUT', body: { paths } })
  } catch (failure) {
    toast.error(messageOf(failure))
  }
}

export const addFavourite = (path: string) => save([...favourites.value.filter((item) => item !== path), path])
export const removeFavourite = (path: string) => save(favourites.value.filter((item) => item !== path))

import { ref } from 'vue'
import { api } from '@/lib/api'
import type { UpdateState } from '@/lib/types'

export const signedIn = ref<boolean | null>(null)
export const updateAvailable = ref(false)

export async function loadSession(): Promise<boolean> {
  try {
    signedIn.value = (await api<{ signedIn: boolean }>('/session')).signedIn
  } catch {
    signedIn.value = false
  }
  return signedIn.value
}

export async function loadUpdateState() {
  try {
    updateAvailable.value = (await api<UpdateState>('/update')).available
  } catch {
    // Not important enough to interrupt anything.
  }
}

import { ref } from 'vue'

/** Items copied or cut in one folder, waiting to be pasted in another. */
export const clipboard = ref<{ op: 'copy' | 'move'; paths: string[] } | null>(null)

export function setClipboard(op: 'copy' | 'move', paths: string[]) {
  clipboard.value = paths.length ? { op, paths: [...paths] } : null
}

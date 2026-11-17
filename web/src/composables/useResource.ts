import type { Ref } from 'vue'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { api, messageOf } from '@/lib/api'

/**
 * Loads a resource and, when an interval is given, keeps it fresh while the
 * tab is visible. Polling stops when the page is hidden or the view is left.
 */
export function useResource<T>(path: string | (() => string), everyMs = 0) {
  const data = ref<T | null>(null) as Ref<T | null>
  const error = ref('')
  const loading = ref(true)
  let timer: ReturnType<typeof setInterval> | undefined
  let request = 0

  async function refresh() {
    const current = ++request
    try {
      const result = await api<T>(typeof path === 'function' ? path() : path)
      if (current !== request) return
      data.value = result
      error.value = ''
    } catch (failure) {
      if (current === request) error.value = messageOf(failure)
    } finally {
      if (current === request) loading.value = false
    }
  }

  function tick() {
    if (!document.hidden) void refresh()
  }

  onMounted(() => {
    void refresh()
    if (everyMs) timer = setInterval(tick, everyMs)
  })
  onBeforeUnmount(() => {
    clearInterval(timer)
    request += 1
  })

  return { data, error, loading, refresh }
}

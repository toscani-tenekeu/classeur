import { onBeforeUnmount, onMounted, ref } from 'vue'

/** The current time, updated every second while the component is shown. */
export function useNow() {
  const now = ref(Date.now())
  let timer: ReturnType<typeof setInterval> | undefined
  onMounted(() => (timer = setInterval(() => (now.value = Date.now()), 1000)))
  onBeforeUnmount(() => clearInterval(timer))
  return now
}

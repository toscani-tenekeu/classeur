const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function bytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return '–'
  let amount = value
  let unit = 0
  while (amount >= 1024 && unit < UNITS.length - 1) {
    amount /= 1024
    unit += 1
  }
  return `${amount >= 100 || unit === 0 ? Math.round(amount) : amount.toFixed(1)} ${UNITS[unit]}`
}

export function percent(value: number): string {
  return `${Math.round(value)}%`
}

export function duration(seconds: number): string {
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days) return `${days}d ${hours}h`
  if (hours) return `${hours}h ${minutes}m`
  if (minutes) return `${minutes}m`
  return `${Math.floor(seconds)}s`
}

export function ago(timestamp: number | null): string {
  if (!timestamp) return 'never'
  const seconds = Math.max(0, (Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'just now'
  return `${duration(seconds)} ago`
}

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
})

export function dateTime(timestamp: number): string {
  return dateTimeFormat.format(timestamp)
}

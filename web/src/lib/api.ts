export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

let onSignedOut: (() => void) | null = null

export function whenSignedOut(handler: () => void) {
  onSignedOut = handler
}

export async function api<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api${path}`, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'same-origin',
      signal: options.signal,
    })
  } catch (error) {
    if (options.signal?.aborted) throw error
    throw new ApiError('The server is not responding.', 0)
  }

  const data = await response.json().catch(() => null)
  if (!response.ok) {
    if (response.status === 401 && !['/login', '/setup'].includes(path)) onSignedOut?.()
    throw new ApiError(data?.message ?? 'The request failed.', response.status)
  }
  return data as T
}

export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body })

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.'
}

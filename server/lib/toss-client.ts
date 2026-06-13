import { clearTokenCache, getAccessToken } from './auth.js'

const TOSS_API_BASE = 'https://openapi.tossinvest.com'

export class TossApiError extends Error {
  status: number
  code?: string
  requestId?: string
  data?: unknown

  constructor(
    status: number,
    message: string,
    options?: { code?: string; requestId?: string; data?: unknown },
  ) {
    super(message)
    this.name = 'TossApiError'
    this.status = status
    this.code = options?.code
    this.requestId = options?.requestId
    this.data = options?.data
  }
}

interface TossRequestOptions {
  method?: 'GET' | 'POST'
  path: string
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  accountSeq?: string | number
  retryOnAuthError?: boolean
}

async function parseErrorPayload(response: Response) {
  let payload: {
    error?: { code?: string; message?: string; data?: unknown; requestId?: string }
  } = {}

  try {
    payload = await response.json()
  } catch {
    payload = {}
  }

  return payload
}

export async function tossRequest<T>(options: TossRequestOptions): Promise<T> {
  return executeTossRequest<T>(options, false)
}

async function executeTossRequest<T>(
  options: TossRequestOptions,
  isRetry: boolean,
): Promise<T> {
  const token = await getAccessToken(isRetry)
  const url = new URL(`${TOSS_API_BASE}${options.path}`)

  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, String(value))
      }
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  }

  if (options.accountSeq !== undefined) {
    headers['X-Tossinvest-Account'] = String(options.accountSeq)
  }

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }

  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })

  const requestId = response.headers.get('X-Request-Id') ?? undefined

  if (!response.ok) {
    const payload = await parseErrorPayload(response)
    const errorCode = payload.error?.code

    if (
      !isRetry &&
      options.retryOnAuthError !== false &&
      response.status === 401 &&
      (errorCode === 'expired-token' || errorCode === 'invalid-token')
    ) {
      clearTokenCache()
      return executeTossRequest<T>(options, true)
    }

    throw new TossApiError(
      response.status,
      payload.error?.message ?? `Toss API error (${response.status})`,
      {
        code: errorCode,
        requestId: payload.error?.requestId ?? requestId,
        data: payload.error?.data,
      },
    )
  }

  if (response.status === 204) {
    return undefined as T
  }

  return (await response.json()) as T
}

export function getDefaultAccountSeq(): string | undefined {
  const value = process.env.TOSS_ACCOUNT_SEQ?.trim()
  return value ? value : undefined
}
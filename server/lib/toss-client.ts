import { clearTokenCache, getAccessToken } from './auth.js';

const TOSS_API_BASE = 'https://openapi.tossinvest.com';

export class TossApiError extends Error {
  status: number;
  code?: string;
  requestId?: string;
  data?: unknown;
  retryAfterMs?: number;

  constructor(
    status: number,
    message: string,
    options?: { code?: string; requestId?: string; data?: unknown; retryAfterMs?: number }
  ) {
    super(message);
    this.name = 'TossApiError';
    this.status = status;
    this.code = options?.code;
    this.requestId = options?.requestId;
    this.data = options?.data;
    this.retryAfterMs = options?.retryAfterMs;
  }
}

interface TossRequestOptions {
  method?: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  accountSeq?: string | number;
  retryOnAuthError?: boolean;
  // 429/5xx 자동 재시도(지수 백오프 + Retry-After). 멱등하지 않은 호출에서 끄려면 false.
  retryOnRateLimit?: boolean;
}

// 공식 문서 권장: 429 수신 시 Retry-After 만큼 대기 후 지수 백오프(1→2→4s)+jitter 로 재시도.
// (https://openapi.tossinvest.com/openapi-docs/overview.md)
const MAX_RATE_LIMIT_RETRIES = 4;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 8000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 권장 대기 시간: Retry-After(초) 우선, 없으면 X-RateLimit-Reset(초). 상한으로 클램프.
function parseRetryAfterMs(response: Response): number | undefined {
  for (const header of ['Retry-After', 'X-RateLimit-Reset']) {
    const raw = response.headers.get(header);
    if (raw) {
      const seconds = Number(raw);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, MAX_BACKOFF_MS);
      }
    }
  }
  return undefined;
}

// Retry-After 가 있으면 그 값을, 없으면 지수 백오프(1·2·4·8s 상한)를 쓰고 항상 jitter 를 더한다.
function computeBackoffMs(attempt: number, retryAfterMs?: number): number {
  const base = retryAfterMs ?? Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  const jitter = Math.random() * Math.min(base, 250);
  return base + jitter;
}

// 429(rate limit) + 5xx(일시적 서버 오류)는 재시도 대상.
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

async function parseErrorPayload(response: Response) {
  let payload: {
    error?: { code?: string; message?: string; data?: unknown; requestId?: string };
  };

  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    payload = {};
  }

  return payload;
}

export async function tossRequest<T>(options: TossRequestOptions): Promise<T> {
  const url = new URL(`${TOSS_API_BASE}${options.path}`);

  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }

  // forceTokenRefresh: 401 만료/무효 토큰을 한 번 만났을 때만 다음 발급을 강제.
  let forceTokenRefresh = false;
  let authRetried = false;
  let rateLimitRetries = 0;

  // 단일 요청을 재시도(토큰 갱신 / 429·5xx 백오프)하는 루프. 모든 재시도는 상한이 있어 무한 대기 없음.
  while (true) {
    const token = await getAccessToken(forceTokenRefresh);
    forceTokenRefresh = false;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };

    if (options.accountSeq !== undefined) {
      headers['X-Tossinvest-Account'] = String(options.accountSeq);
    }

    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    const requestId = response.headers.get('X-Request-Id') ?? undefined;

    if (response.ok) {
      if (response.status === 204) {
        return undefined as T;
      }
      return (await response.json()) as T;
    }

    const payload = await parseErrorPayload(response);
    const errorCode = payload.error?.code;

    // 1) 만료/무효 토큰(401) → 토큰 캐시 비우고 1회 강제 갱신 후 재시도.
    if (
      !authRetried &&
      options.retryOnAuthError !== false &&
      response.status === 401 &&
      (errorCode === 'expired-token' || errorCode === 'invalid-token')
    ) {
      clearTokenCache();
      forceTokenRefresh = true;
      authRetried = true;
      continue;
    }

    // 2) 429/5xx → Retry-After(또는 지수 백오프 + jitter)로 대기 후 재시도(상한까지).
    if (
      isRetryableStatus(response.status) &&
      options.retryOnRateLimit !== false &&
      rateLimitRetries < MAX_RATE_LIMIT_RETRIES
    ) {
      const waitMs = computeBackoffMs(rateLimitRetries, parseRetryAfterMs(response));
      rateLimitRetries += 1;
      await delay(waitMs);
      continue;
    }

    throw new TossApiError(
      response.status,
      payload.error?.message ?? `Toss API error (${response.status})`,
      {
        code: errorCode,
        requestId: payload.error?.requestId ?? requestId,
        data: payload.error?.data,
        retryAfterMs: parseRetryAfterMs(response),
      }
    );
  }
}

export function getDefaultAccountSeq(): string | undefined {
  const value = process.env.TOSS_ACCOUNT_SEQ?.trim();
  return value ? value : undefined;
}

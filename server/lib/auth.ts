const TOSS_API_BASE = 'https://openapi.tossinvest.com';

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;
let lastAuthError: string | null = null;

// 토큰 발급(AUTH, 초당 5회)도 일시적 429/5xx 를 만나면 백오프 후 재시도한다.
const MAX_TOKEN_RETRIES = 3;
const TOKEN_BASE_BACKOFF_MS = 1000;
const TOKEN_MAX_BACKOFF_MS = 8000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tokenBackoffMs(attempt: number, response: Response): number {
  const retryAfter = Number(
    response.headers.get('Retry-After') ?? response.headers.get('X-RateLimit-Reset') ?? ''
  );
  const base =
    Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, TOKEN_MAX_BACKOFF_MS)
      : Math.min(TOKEN_BASE_BACKOFF_MS * 2 ** attempt, TOKEN_MAX_BACKOFF_MS);
  return base + Math.random() * Math.min(base, 250);
}

function getCredentials() {
  const clientId = process.env.TOSS_CLIENT_ID?.trim();
  const clientSecret = process.env.TOSS_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) {
    throw new Error('TOSS_CLIENT_ID and TOSS_CLIENT_SECRET must be set in .env');
  }

  return { clientId, clientSecret };
}

export function clearTokenCache() {
  tokenCache = null;
}

export function getLastAuthError() {
  return lastAuthError;
}

export function getTokenCacheStatus() {
  if (!tokenCache) {
    return { cached: false as const };
  }

  return {
    cached: true as const,
    expiresAt: tokenCache.expiresAt,
    expiresInMs: Math.max(0, tokenCache.expiresAt - Date.now()),
  };
}

// 진행 중인 토큰 발급 1건을 공유한다(single-flight). 동시 요청들이 각자
// /oauth2/token 을 POST 하면 토큰 엔드포인트가 429(rate-limit-exceeded)로 거부되고
// 그게 503/401 로 클라이언트까지 전파된다. 한 번만 발급하고 모두가 그 결과를 공유한다.
let tokenInFlight: Promise<string> | null = null;

export async function getAccessToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && tokenCache && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.accessToken;
  }

  // 이미 발급이 진행 중이면 새로 호출하지 않고 그 결과를 함께 기다린다.
  if (tokenInFlight) {
    return tokenInFlight;
  }

  tokenInFlight = issueToken().finally(() => {
    tokenInFlight = null;
  });

  return tokenInFlight;
}

async function issueToken(): Promise<string> {
  const { clientId, clientSecret } = getCredentials();

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  let attempt = 0;

  while (true) {
    const response = await fetch(`${TOSS_API_BASE}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (response.ok) {
      const data = (await response.json()) as {
        access_token: string;
        expires_in: number;
      };

      if (!data.access_token) {
        clearTokenCache();
        throw new Error('Token issuance succeeded but access_token is missing in response');
      }

      tokenCache = {
        accessToken: data.access_token,
        expiresAt: Date.now() + data.expires_in * 1000,
      };
      lastAuthError = null;

      return tokenCache.accessToken;
    }

    // 일시적 429/5xx 는 백오프 후 재시도(상한까지). 그 외(401 등)는 즉시 실패.
    if ((response.status === 429 || response.status >= 500) && attempt < MAX_TOKEN_RETRIES) {
      const waitMs = tokenBackoffMs(attempt, response);
      attempt += 1;
      await delay(waitMs);
      continue;
    }

    clearTokenCache();
    const text = await response.text();

    let message = `Token issuance failed (${response.status})`;
    try {
      const payload = JSON.parse(text) as {
        error?: string;
        error_description?: string;
      };
      if (payload.error || payload.error_description) {
        message = `${message}: ${payload.error ?? 'unknown'} - ${payload.error_description ?? text}`;
      }
    } catch {
      message = `${message}: ${text}`;
    }

    if (response.status === 401) {
      lastAuthError = `${message}. WTS > 설정 > Open API 에서 client_id/client_secret 을 다시 확인하거나 재발급하세요.`;
      throw new Error(lastAuthError);
    }

    lastAuthError = message;
    throw new Error(message);
  }
}

export async function warmUpAuth() {
  await getAccessToken();
}

const TOSS_API_BASE = 'https://openapi.tossinvest.com';

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;
let lastAuthError: string | null = null;

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

export async function getAccessToken(forceRefresh = false): Promise<string> {
  const { clientId, clientSecret } = getCredentials();

  if (!forceRefresh && tokenCache && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(`${TOSS_API_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
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

export async function warmUpAuth() {
  await getAccessToken();
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError } from '../../shared/api/client';

interface UsePollingOptions {
  initialDelayMs?: number;
  rateLimitBackoffMs?: number;
}

const recentPollStarts = new Map<string, number>();
const DEDUP_WINDOW_MS = 1500;

function getBackoffMs(error: unknown, rateLimitBackoffMs: number, intervalMs: number) {
  if (error instanceof ApiRequestError && error.isRateLimited) {
    // 서버가 전달한 Retry-After(토스 권장 대기)가 있으면 우선 사용, 없으면 기본 백오프.
    return error.retryAfterMs ?? rateLimitBackoffMs;
  }
  return intervalMs;
}

export function usePolling<T>(params: {
  fetcher: () => Promise<T>;
  intervalMs: number;
  enabled?: boolean;
  resetKey?: string | number;
  options?: UsePollingOptions;
}) {
  const { fetcher, intervalMs, enabled = true, resetKey, options } = params;
  const { initialDelayMs = 0, rateLimitBackoffMs = 10_000 } = options ?? {};
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const fetcherRef = useRef(fetcher);
  const runningRef = useRef(false);
  const hasDataRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelledRef = useRef(false);
  const pendingForceRefreshRef = useRef(false);
  const runRef = useRef<(force?: boolean) => void>(() => {});

  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!enabled) return;

    hasDataRef.current = false;
    setData(null);
    setError(null);
    setLoading(false);
    setRefreshing(false);

    const pollKey = String(resetKey ?? 'default');
    cancelledRef.current = false;
    pendingForceRefreshRef.current = false;

    const schedule = (delayMs: number) => {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        void run();
      }, delayMs);
    };

    const dedupWindowMs = Math.min(
      DEDUP_WINDOW_MS,
      intervalMs > 0 ? Math.max(0, intervalMs - 50) : DEDUP_WINDOW_MS
    );

    const run = async (force = false) => {
      if (cancelledRef.current) return;

      if (runningRef.current) {
        if (force) {
          pendingForceRefreshRef.current = true;
        } else {
          schedule(intervalMs);
        }
        return;
      }

      const now = Date.now();
      const lastStart = recentPollStarts.get(pollKey) ?? 0;
      const elapsed = now - lastStart;
      if (!force && elapsed < dedupWindowMs) {
        schedule(dedupWindowMs - elapsed);
        return;
      }

      recentPollStarts.set(pollKey, now);
      runningRef.current = true;

      if (!hasDataRef.current) {
        setLoading(true);
      } else {
        setRefreshing(true);
      }

      let nextDelayMs = intervalMs;

      try {
        const result = await fetcherRef.current();
        if (!cancelledRef.current) {
          // fetcher 가 undefined 를 반환하면 "이번 주기 갱신 없음"으로 보고 직전 data 를 유지한다.
          // (시세 fetch 가 실패/가드로 undefined 를 돌려줄 때 currentPrice 가 사라져
          //  매수 가능·예상 금액 등이 깜빡이는 문제 방지. null 은 명시적 비우기로 그대로 반영.)
          if (result !== undefined) {
            setData(result);
            hasDataRef.current = true;
          }
          setError(null);
        }
      } catch (err) {
        if (!cancelledRef.current) {
          setError(err instanceof Error ? err.message : '알 수 없는 오류가 발생했습니다');
          nextDelayMs = getBackoffMs(err, rateLimitBackoffMs, intervalMs);
        }
      } finally {
        runningRef.current = false;
        if (!cancelledRef.current) {
          setLoading(false);
          setRefreshing(false);

          if (pendingForceRefreshRef.current) {
            pendingForceRefreshRef.current = false;
            void run(true);
          } else {
            schedule(nextDelayMs);
          }
        }
      }
    };

    runRef.current = run;
    schedule(initialDelayMs);

    return () => {
      cancelledRef.current = true;
      runningRef.current = false;
      pendingForceRefreshRef.current = false;
      clearTimeout(timerRef.current);
      runRef.current = () => {};
    };
  }, [enabled, initialDelayMs, intervalMs, rateLimitBackoffMs, resetKey]);

  const refreshNow = useCallback(() => {
    if (cancelledRef.current || !enabled) return;
    clearTimeout(timerRef.current);
    runRef.current(true);
  }, [enabled]);

  return { data, error, loading, refreshing, refreshNow };
}

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
    return rateLimitBackoffMs;
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
          setData(result);
          setError(null);
          hasDataRef.current = true;
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

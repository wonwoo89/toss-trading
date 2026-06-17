import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../shared/api/client';
import {
  getCachedCandles,
  getCandleCount,
  getHistoryCandleCount,
  mapApiCandles,
  mergeChartCandles,
  setCachedCandles,
} from '../lib/candles';
import { unwrapResult } from '../lib/parse';
import type { CandleInterval, ChartCandle } from '../types';

const CANDLE_POLL_MS = 1000;
const CANDLE_INITIAL_DELAY_MS = 500;

interface UseChartCandlesOptions {
  pollIntervalMs?: number;
  initialDelayMs?: number;
}

export function useChartCandles(
  symbol: string,
  interval: CandleInterval,
  enabled: boolean,
  options?: UseChartCandlesOptions
) {
  const pollIntervalMs = options?.pollIntervalMs ?? CANDLE_POLL_MS;
  const initialDelayMs = options?.initialDelayMs ?? CANDLE_INITIAL_DELAY_MS;

  const [candles, setCandles] = useState<ChartCandle[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);

  const historyCursorRef = useRef<string | null>(null);
  const loadingOlderRef = useRef(false);
  const hasDataRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelledRef = useRef(false);
  const runningRef = useRef(false);
  const pendingForceRefreshRef = useRef(false);
  const runRef = useRef<() => void>(() => {});

  // 현재 요청 대상(종목+인터벌) 키. 렌더마다 최신값으로 갱신.
  // 종목을 바꾼 뒤 늦게 도착한 이전 종목 응답(stale)을 식별해 폐기하는 데 쓴다.
  const activeKeyRef = useRef('');
  activeKeyRef.current = `${symbol}:${interval}`;

  useEffect(() => {
    // 종목/인터벌 변경 시: 캐시에 마지막으로 본 차트가 있으면 즉시 복원(빈 차트 깜빡임 방지),
    // 없으면 비운다. 어느 경우든 백그라운드로 최신 캔들을 다시 받아 갱신한다.
    const cached = getCachedCandles(`${symbol}:${interval}`);
    historyCursorRef.current = null;
    loadingOlderRef.current = false;
    hasDataRef.current = !!(cached && cached.length);
    setCandles(cached ?? []);
    setLoading(false);
    setRefreshing(false);
    setLoadingOlder(false);
    setError(null);
    setHasMoreHistory(false);
  }, [symbol, interval]);

  const refreshLatest = useCallback(async () => {
    const requestKey = `${symbol}:${interval}`;
    const page = unwrapResult(await api.getCandles(symbol, interval, getCandleCount(interval)));
    // 응답 도착 시점에 종목/인터벌이 바뀌었으면 stale → 폐기(이전 종목 캔들이 섞이는 것 방지).
    if (requestKey !== activeKeyRef.current) return [];
    const mapped = mapApiCandles(page.candles);

    setCandles((prev) => {
      const merged = mergeChartCandles(prev, mapped);
      setCachedCandles(requestKey, merged);
      return merged;
    });
    setError(null);
    hasDataRef.current = mapped.length > 0;

    if (historyCursorRef.current === null) {
      historyCursorRef.current = page.nextBefore;
      setHasMoreHistory(page.nextBefore !== null);
    }

    return mapped;
  }, [interval, symbol]);

  useEffect(() => {
    if (!enabled) return;

    cancelledRef.current = false;
    pendingForceRefreshRef.current = false;

    const schedule = (delayMs: number) => {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        void run();
      }, delayMs);
    };

    const run = async () => {
      if (cancelledRef.current) return;

      if (runningRef.current) {
        pendingForceRefreshRef.current = true;
        return;
      }

      runningRef.current = true;

      if (!hasDataRef.current) {
        setLoading(true);
      } else {
        setRefreshing(true);
      }

      try {
        await refreshLatest();
      } catch (err) {
        if (!cancelledRef.current) {
          setError(err instanceof Error ? err.message : '캔들 데이터를 불러오지 못했습니다.');
        }
      } finally {
        runningRef.current = false;
        if (!cancelledRef.current) {
          setLoading(false);
          setRefreshing(false);

          if (pendingForceRefreshRef.current) {
            pendingForceRefreshRef.current = false;
            void run();
          } else {
            schedule(pollIntervalMs);
          }
        }
      }
    };

    runRef.current = () => {
      clearTimeout(timerRef.current);
      void run();
    };

    schedule(initialDelayMs);

    return () => {
      cancelledRef.current = true;
      runningRef.current = false;
      pendingForceRefreshRef.current = false;
      clearTimeout(timerRef.current);
      runRef.current = () => {};
    };
  }, [enabled, initialDelayMs, pollIntervalMs, refreshLatest]);

  const refreshNow = useCallback(() => {
    if (cancelledRef.current || !enabled) return;
    runRef.current();
  }, [enabled]);

  const loadOlder = useCallback(async () => {
    const requestKey = `${symbol}:${interval}`;
    const before = historyCursorRef.current;
    if (!before || loadingOlderRef.current) return;

    loadingOlderRef.current = true;
    setLoadingOlder(true);

    try {
      const page = unwrapResult(
        await api.getCandles(symbol, interval, getHistoryCandleCount(), before)
      );
      // 종목/인터벌이 바뀐 뒤 도착한 과거 캔들 응답은 폐기.
      if (requestKey !== activeKeyRef.current) return;
      const mapped = mapApiCandles(page.candles);

      setCandles((prev) => {
        const merged = mergeChartCandles(mapped, prev);
        setCachedCandles(requestKey, merged);
        return merged;
      });
      setError(null);

      historyCursorRef.current = page.nextBefore;
      setHasMoreHistory(page.nextBefore !== null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '과거 캔들을 불러오지 못했습니다.');
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [interval, symbol]);

  return {
    candles,
    loading,
    refreshing,
    loadingOlder,
    error,
    hasMoreHistory,
    loadOlder,
    refreshNow,
  };
}

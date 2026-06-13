import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../shared/api/client';
import {
  getCandleCount,
  getHistoryCandleCount,
  mapApiCandles,
  mergeChartCandles,
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

  useEffect(() => {
    historyCursorRef.current = null;
    loadingOlderRef.current = false;
    hasDataRef.current = false;
    setCandles([]);
    setLoading(false);
    setRefreshing(false);
    setLoadingOlder(false);
    setError(null);
    setHasMoreHistory(false);
  }, [symbol, interval]);

  const refreshLatest = useCallback(async () => {
    const page = unwrapResult(await api.getCandles(symbol, interval, getCandleCount(interval)));
    const mapped = mapApiCandles(page.candles);

    setCandles((prev) => mergeChartCandles(prev, mapped));
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
    const before = historyCursorRef.current;
    if (!before || loadingOlderRef.current) return;

    loadingOlderRef.current = true;
    setLoadingOlder(true);

    try {
      const page = unwrapResult(
        await api.getCandles(symbol, interval, getHistoryCandleCount(), before)
      );
      const mapped = mapApiCandles(page.candles);

      setCandles((prev) => mergeChartCandles(mapped, prev));
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

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
  // 진행 중 요청의 시작 시각 — 요청이 비정상적으로 오래 잠겨 있으면 강제 해제(이중 안전).
  const runStartedAtRef = useRef(0);
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
      runStartedAtRef.current = Date.now();

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

    // 포그라운드 복귀 워치독 — 앱 백그라운드/네트워크 전환 중 요청이 hang 돼 폴링 체인이
    // 끊긴 경우(runningRef 잠김·타이머 미예약), 복귀 시 즉시 체인을 재시작한다.
    // (요청 자체는 API 타임아웃이 정리해 주지만, 복귀 즉시 최신 캔들로 갱신하는 효과도 있다)
    const onResume = () => {
      if (cancelledRef.current || document.visibilityState !== 'visible') return;
      if (runningRef.current) {
        // 타임아웃(15초)보다 훨씬 오래 잠겨 있으면 비정상 — 강제 해제 후 재시작
        if (Date.now() - runStartedAtRef.current > 60_000) {
          runningRef.current = false;
        } else {
          pendingForceRefreshRef.current = true;
          return;
        }
      }
      clearTimeout(timerRef.current);
      void run();
    };
    document.addEventListener('visibilitychange', onResume);
    window.addEventListener('focus', onResume);
    window.addEventListener('pageshow', onResume);

    return () => {
      cancelledRef.current = true;
      runningRef.current = false;
      pendingForceRefreshRef.current = false;
      clearTimeout(timerRef.current);
      runRef.current = () => {};
      document.removeEventListener('visibilitychange', onResume);
      window.removeEventListener('focus', onResume);
      window.removeEventListener('pageshow', onResume);
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
        await api.getCandles(symbol, interval, getHistoryCandleCount(interval), before)
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

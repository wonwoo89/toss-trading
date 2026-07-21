import { api } from '../api/client';
import { mapApiCandles } from './candles';
import { unwrapResult } from './parse';
import { runBacktest, type BacktestConfig, type BacktestResult } from './backtest';
import { optimizeBacktestScenarios, type OptimizedScenario } from './backtestOptimize';
import type { CandleInterval, ChartCandle } from '../types';

export const BACKTEST_INTERVAL_OPTIONS: {
  value: CandleInterval;
  label: string;
  fetch: number;
}[] = [
  { value: '1m', label: '1분', fetch: 1500 },
  { value: '5m', label: '5분', fetch: 2400 },
  { value: '10m', label: '10분', fetch: 1000 },
  { value: '1d', label: '일', fetch: 600 },
];

async function fetchHistory(
  symbol: string,
  interval: CandleInterval,
  targetCount: number
): Promise<ChartCandle[]> {
  const byTime = new Map<number, ChartCandle>();
  let before: string | undefined;
  // 페이지당 200개 — 목표량을 채울 만큼 + 여유 2페이지(중복/결측 대비)까지 순회.
  const maxPages = Math.ceil(targetCount / 200) + 2;
  for (let page = 0; page < maxPages && byTime.size < targetCount; page += 1) {
    const result = unwrapResult(await api.getCandles(symbol, interval, 200, before));
    for (const candle of mapApiCandles(result.candles)) {
      byTime.set(candle.time, candle);
    }
    if (!result.nextBefore) break;
    before = result.nextBefore;
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export interface SymbolBacktestOutcome {
  result: BacktestResult;
  usedCandles: number;
  /** AI 최적화 그리드(누적 내림차순) — 통합 러너(runSymbolBacktestFull)에서만 채워진다. */
  scenarios?: OptimizedScenario[];
}

/** 한 종목의 과거 캔들을 받아 백테스트를 실행한다. 데이터 부족 시 throw. */
export async function runSymbolBacktest(
  symbol: string,
  interval: CandleInterval,
  config: BacktestConfig
): Promise<SymbolBacktestOutcome> {
  const target = BACKTEST_INTERVAL_OPTIONS.find((o) => o.value === interval)?.fetch ?? 1000;
  const candles = await fetchHistory(symbol, interval, target);
  if (candles.length < 80) {
    throw new Error('캔들 데이터가 부족합니다(최소 ~80개 필요).');
  }
  return { result: runBacktest(candles, config), usedCandles: candles.length };
}

/** 백테스트 + AI 최적화 그리드 통합 러너 — 캔들을 1회만 받아 둘 다 계산한다(API 부담 동일). */
export async function runSymbolBacktestFull(
  symbol: string,
  interval: CandleInterval,
  config: BacktestConfig
): Promise<SymbolBacktestOutcome> {
  const target = BACKTEST_INTERVAL_OPTIONS.find((o) => o.value === interval)?.fetch ?? 1000;
  const candles = await fetchHistory(symbol, interval, target);
  if (candles.length < 80) {
    throw new Error('캔들 데이터가 부족합니다(최소 ~80개 필요).');
  }
  return {
    result: runBacktest(candles, config),
    usedCandles: candles.length,
    scenarios: optimizeBacktestScenarios(candles, {
      forwardBars: config.forwardBars,
      costPct: config.costPct,
    }),
  };
}

/** 익절×손절 그리드 전수 백테스트 — 캔들은 1회만 받아 전 시나리오에 재사용. */
export async function optimizeSymbolBacktest(
  symbol: string,
  interval: CandleInterval,
  base: { forwardBars: number; costPct: number }
): Promise<{ scenarios: OptimizedScenario[]; usedCandles: number }> {
  const target = BACKTEST_INTERVAL_OPTIONS.find((o) => o.value === interval)?.fetch ?? 1000;
  const candles = await fetchHistory(symbol, interval, target);
  if (candles.length < 80) {
    throw new Error('캔들 데이터가 부족합니다(최소 ~80개 필요).');
  }
  return { scenarios: optimizeBacktestScenarios(candles, base), usedCandles: candles.length };
}

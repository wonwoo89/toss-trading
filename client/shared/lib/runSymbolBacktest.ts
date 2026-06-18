import { api } from '../api/client';
import { mapApiCandles } from './candles';
import { unwrapResult } from './parse';
import { runBacktest, type BacktestConfig, type BacktestResult } from './backtest';
import type { CandleInterval, ChartCandle } from '../types';

export const BACKTEST_INTERVAL_OPTIONS: {
  value: CandleInterval;
  label: string;
  fetch: number;
}[] = [
  { value: '1m', label: '1분', fetch: 1500 },
  { value: '5m', label: '5분', fetch: 1200 },
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
  for (let page = 0; page < 12 && byTime.size < targetCount; page += 1) {
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

import { toNumber } from './parse';
import type { CandleInterval, CandleRaw, ChartCandle } from '../types';

export function getCandleCount(interval: CandleInterval) {
  if (interval === '1M') return 24;
  if (interval === '1w') return 52;
  return 120;
}

export function getHistoryCandleCount() {
  return 200;
}

export function mergeChartCandles(...groups: ChartCandle[][]): ChartCandle[] {
  const byTime = new Map<number, ChartCandle>();

  for (const group of groups) {
    for (const candle of group) {
      byTime.set(candle.time, candle);
    }
  }

  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

// 종목+인터벌별 최근 캔들 캐시. 종목 전환 시 마지막으로 본 차트를 즉시 보여줘
// "변경 딜레이(빈 차트)"를 없앤다. 메모리만 사용(세션 한정), 최근 N개만 유지.
const candleCache = new Map<string, ChartCandle[]>();
const CANDLE_CACHE_LIMIT = 30;

export function getCachedCandles(key: string): ChartCandle[] | undefined {
  return candleCache.get(key);
}

export function setCachedCandles(key: string, candles: ChartCandle[]): void {
  // 재삽입으로 LRU 순서 유지
  candleCache.delete(key);
  candleCache.set(key, candles);
  if (candleCache.size > CANDLE_CACHE_LIMIT) {
    const oldest = candleCache.keys().next().value;
    if (oldest !== undefined) candleCache.delete(oldest);
  }
}

export function mapApiCandles(candles: CandleRaw[]): ChartCandle[] {
  return candles
    .map((candle) => ({
      time: Math.floor(new Date(candle.timestamp).getTime() / 1000),
      open: toNumber(candle.openPrice) ?? 0,
      high: toNumber(candle.highPrice) ?? 0,
      low: toNumber(candle.lowPrice) ?? 0,
      close: toNumber(candle.closePrice) ?? 0,
      volume: toNumber(candle.volume) ?? 0,
    }))
    .filter((candle) => candle.open > 0 && candle.close > 0);
}

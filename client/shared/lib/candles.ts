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

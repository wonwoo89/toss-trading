import type { ChartCandle } from '../types';

export const BOLLINGER_PERIOD = 20;
export const BOLLINGER_STD_DEV = 2;

export interface BollingerBandPoint {
  time: number;
  upper: number;
  middle: number;
  lower: number;
}

function calculateStdDev(values: number[]) {
  if (values.length === 0) return undefined;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function calculateBollingerBandSeries(
  candles: ChartCandle[],
  period = BOLLINGER_PERIOD,
  stdDevMultiplier = BOLLINGER_STD_DEV
): BollingerBandPoint[] {
  const sorted = candles.slice().sort((a, b) => a.time - b.time);
  if (sorted.length < period) return [];

  const points: BollingerBandPoint[] = [];

  for (let index = period - 1; index < sorted.length; index += 1) {
    const window = sorted.slice(index - period + 1, index + 1);
    const closes = window.map((candle) => candle.close);
    const middle = closes.reduce((sum, value) => sum + value, 0) / period;
    const stdDev = calculateStdDev(closes);
    if (stdDev === undefined) continue;

    points.push({
      time: sorted[index].time,
      upper: middle + stdDevMultiplier * stdDev,
      middle,
      lower: middle - stdDevMultiplier * stdDev,
    });
  }

  return points;
}

export function getLatestBollingerBands(candles: ChartCandle[]) {
  const series = calculateBollingerBandSeries(candles);
  return series.length > 0 ? series[series.length - 1] : undefined;
}

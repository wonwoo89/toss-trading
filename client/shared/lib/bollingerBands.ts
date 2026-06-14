import { getIndicatorBackend } from './indicatorBackend';
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

  // WASM 백엔드(워커)가 있으면 window 계산을 가속하고, JS 는 time 매핑만 한다.
  const accelerated = getIndicatorBackend().bollingerWindows?.(
    sorted.map((candle) => candle.close),
    period,
    stdDevMultiplier
  );
  if (accelerated) {
    const acceleratedPoints: BollingerBandPoint[] = [];
    for (let pointIndex = 0; pointIndex * 3 < accelerated.length; pointIndex += 1) {
      acceleratedPoints.push({
        time: sorted[period - 1 + pointIndex].time,
        upper: accelerated[pointIndex * 3],
        middle: accelerated[pointIndex * 3 + 1],
        lower: accelerated[pointIndex * 3 + 2],
      });
    }
    return acceleratedPoints;
  }

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

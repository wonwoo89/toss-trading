import { buildChartSignalSnapshot, type ChartSignalLevel } from './chartSignals';
import { getIndicatorBackend } from './indicatorBackend';
import { TAKE_PROFIT_RATE_OPTIONS, type TakeProfitRateOption } from './takeProfitRatePreference';
import type { ChartCandle } from '../types';

const SUPPORT_RESISTANCE_PERIOD = 20;
const ATR_PERIOD = 14;
const HIGH_ATR_RATIO = 0.02;
const LOW_ATR_RATIO = 0.005;

export interface TakeProfitRateRecommendationInput {
  candles?: ChartCandle[];
  currentPrice?: number;
  bids?: { quantity: number }[];
  asks?: { quantity: number }[];
}

export interface TakeProfitRateRecommendation {
  available: boolean;
  rate: TakeProfitRateOption;
  rateLabel: string;
}

const SIGNAL_BASE: Record<ChartSignalLevel, number> = {
  strong_buy: 5,
  weak_buy: 3,
  neutral: 3,
  weak_sell: 1,
  strong_sell: 1,
};

function snapToRate(score: number): TakeProfitRateOption {
  const clamped = Math.min(20, Math.max(1, score));
  return TAKE_PROFIT_RATE_OPTIONS.reduce((best, option) =>
    Math.abs(option - clamped) < Math.abs(best - clamped) ? option : best
  );
}

function getSupportResistance(candles: ChartCandle[]) {
  const sorted = candles.slice().sort((a, b) => a.time - b.time);
  const recent = sorted.slice(-SUPPORT_RESISTANCE_PERIOD);
  if (recent.length < 5) {
    return { support: undefined, resistance: undefined };
  }

  return {
    support: Math.min(...recent.map((candle) => candle.low)),
    resistance: Math.max(...recent.map((candle) => candle.high)),
  };
}

function calculateAtr(candles: ChartCandle[]) {
  const accelerated = getIndicatorBackend().atrFromCandles?.(candles, ATR_PERIOD);
  if (accelerated != null) return accelerated;

  if (candles.length < ATR_PERIOD + 1) return undefined;

  const sorted = candles.slice().sort((a, b) => a.time - b.time);
  const trueRanges: number[] = [];

  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index];
    const previous = sorted[index - 1];
    trueRanges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      )
    );
  }

  const recent = trueRanges.slice(-ATR_PERIOD);
  return recent.reduce((sum, value) => sum + value, 0) / recent.length;
}

export function buildTakeProfitRateRecommendation(
  input: TakeProfitRateRecommendationInput
): TakeProfitRateRecommendation {
  const { candles = [], currentPrice, bids = [], asks = [] } = input;

  if (currentPrice === undefined || currentPrice <= 0) {
    return {
      available: false,
      rate: 3,
      rateLabel: '—',
    };
  }

  const signal = buildChartSignalSnapshot({ candles, bids, asks });
  let score = signal.insufficientData ? 3 : SIGNAL_BASE[signal.level];

  const { resistance } = getSupportResistance(candles);
  const resistanceGap =
    resistance !== undefined && resistance > currentPrice
      ? ((resistance - currentPrice) / currentPrice) * 100
      : undefined;

  if (resistanceGap !== undefined) {
    if (resistanceGap < 2) {
      score -= 2;
    } else if (resistanceGap < 4) {
      score -= 1;
    } else if (resistanceGap > 8) {
      score += 3;
    } else if (resistanceGap > 5) {
      score += 2;
    }
  }

  const atr = calculateAtr(candles);
  const atrRatio = atr !== undefined ? atr / currentPrice : undefined;

  if (atrRatio !== undefined) {
    if (atrRatio >= HIGH_ATR_RATIO) {
      score += 2;
    } else if (atrRatio >= 0.012) {
      score += 1;
    } else if (atrRatio <= LOW_ATR_RATIO) {
      score -= 1;
    }
  }

  if (signal.level === 'strong_buy' && resistanceGap !== undefined && resistanceGap > 6) {
    score = Math.max(score, 5);
  }

  if (signal.level === 'strong_sell') {
    score = Math.min(score, 1);
  }

  const rate = snapToRate(score);

  return {
    available: true,
    rate,
    rateLabel: `${rate}%`,
  };
}

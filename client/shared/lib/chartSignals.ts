import { buildExtendedIndicatorMetrics } from './chartExtendedIndicators';
import { formatWarningSummary } from './warningLabels';
import type { ChartCandle } from '../types';

export type ChartSignalLevel = 'strong_buy' | 'weak_buy' | 'neutral' | 'weak_sell' | 'strong_sell';

export type ChartSignalBias = 'bullish' | 'bearish' | 'neutral';

export interface ChartSignalMetric {
  id: string;
  label: string;
  value: string;
  bias: ChartSignalBias;
}

export interface ChartSignalInput {
  candles: ChartCandle[];
  bids?: { quantity: number }[];
  asks?: { quantity: number }[];
  warnings?: string[];
}

export interface ChartSignalSnapshot {
  level: ChartSignalLevel;
  label: string;
  score: number;
  summary: string;
  metrics: ChartSignalMetric[];
  insufficientData: boolean;
}

const RSI_PERIOD = 14;
const SMA_FAST_PERIOD = 20;
const SMA_SLOW_PERIOD = 50;
const VOLUME_PERIOD = 20;
const MIN_CANDLES = RSI_PERIOD + 1;

const SIGNAL_LABELS: Record<ChartSignalLevel, string> = {
  strong_buy: '강매수',
  weak_buy: '약매수',
  neutral: '관망',
  weak_sell: '약매도',
  strong_sell: '강매도',
};

function average(values: number[]) {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calculateSma(values: number[], period: number) {
  if (values.length < period) return undefined;
  return average(values.slice(-period));
}

function calculateRsi(closes: number[], period = RSI_PERIOD) {
  if (closes.length < period + 1) return undefined;

  let gainSum = 0;
  let lossSum = 0;

  for (let index = closes.length - period; index < closes.length; index += 1) {
    const change = closes[index] - closes[index - 1];
    if (change >= 0) gainSum += change;
    else lossSum += Math.abs(change);
  }

  const avgGain = gainSum / period;
  const avgLoss = lossSum / period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function getTrendBias(
  close: number,
  smaFast?: number,
  smaSlow?: number
): { bias: ChartSignalBias; score: number; label: string } {
  if (smaFast === undefined) {
    return { bias: 'neutral', score: 0, label: '—' };
  }

  if (smaSlow !== undefined) {
    if (close > smaFast && smaFast > smaSlow) {
      return { bias: 'bullish', score: 2, label: '상승 추세' };
    }
    if (close < smaFast && smaFast < smaSlow) {
      return { bias: 'bearish', score: -2, label: '하락 추세' };
    }
  }

  if (close > smaFast) {
    return { bias: 'bullish', score: 1, label: '단기 상회' };
  }
  if (close < smaFast) {
    return { bias: 'bearish', score: -1, label: '단기 하회' };
  }

  return { bias: 'neutral', score: 0, label: '횡보' };
}

function getRsiBias(rsi?: number): { bias: ChartSignalBias; score: number; label: string } {
  if (rsi === undefined) {
    return { bias: 'neutral', score: 0, label: '—' };
  }

  if (rsi <= 30) return { bias: 'bullish', score: 2, label: `RSI ${rsi.toFixed(0)} 과매도` };
  if (rsi <= 40) return { bias: 'bullish', score: 1, label: `RSI ${rsi.toFixed(0)} 약세` };
  if (rsi >= 70) return { bias: 'bearish', score: -2, label: `RSI ${rsi.toFixed(0)} 과매수` };
  if (rsi >= 60) return { bias: 'bearish', score: -1, label: `RSI ${rsi.toFixed(0)} 강세` };
  return { bias: 'neutral', score: 0, label: `RSI ${rsi.toFixed(0)}` };
}

function getVolumeBias(candles: ChartCandle[]): {
  bias: ChartSignalBias;
  score: number;
  label: string;
} {
  const volumes = candles.map((candle) => candle.volume);
  const averageVolume = calculateSma(volumes, VOLUME_PERIOD);
  const lastCandle = candles[candles.length - 1];

  if (averageVolume === undefined || averageVolume <= 0 || !lastCandle) {
    return { bias: 'neutral', score: 0, label: '—' };
  }

  const ratio = lastCandle.volume / averageVolume;
  const ratioLabel = `${ratio.toFixed(1)}x`;
  const isUpCandle = lastCandle.close >= lastCandle.open;

  if (ratio >= 1.5 && isUpCandle) {
    return { bias: 'bullish', score: 1, label: `거래량 ${ratioLabel}` };
  }
  if (ratio >= 1.5 && !isUpCandle) {
    return { bias: 'bearish', score: -1, label: `거래량 ${ratioLabel}` };
  }

  return { bias: 'neutral', score: 0, label: `거래량 ${ratioLabel}` };
}

function getOrderbookBias(
  bids: { quantity: number }[] = [],
  asks: { quantity: number }[] = []
): { bias: ChartSignalBias; score: number; label: string } {
  const bidTotal = bids.reduce((sum, entry) => sum + entry.quantity, 0);
  const askTotal = asks.reduce((sum, entry) => sum + entry.quantity, 0);
  const total = bidTotal + askTotal;

  if (total <= 0) {
    return { bias: 'neutral', score: 0, label: '—' };
  }

  const bidRatio = bidTotal / total;
  const percent = Math.round(bidRatio * 100);

  if (bidRatio >= 0.58) {
    return { bias: 'bullish', score: 1, label: `호가 매수 ${percent}%` };
  }
  if (bidRatio <= 0.42) {
    return { bias: 'bearish', score: -1, label: `호가 매도 ${100 - percent}%` };
  }

  return { bias: 'neutral', score: 0, label: `호가 균형 ${percent}%` };
}

function getSignalLevel(score: number): ChartSignalLevel {
  if (score >= 4) return 'strong_buy';
  if (score >= 2) return 'weak_buy';
  if (score <= -4) return 'strong_sell';
  if (score <= -2) return 'weak_sell';
  return 'neutral';
}

function getSignalSummary(level: ChartSignalLevel) {
  switch (level) {
    case 'strong_buy':
      return '추세·모멘텀·수급이 매수 쪽으로 강하게 정렬됐습니다.';
    case 'weak_buy':
      return '일부 지표가 매수 우위입니다. 추가 확인이 필요합니다.';
    case 'weak_sell':
      return '일부 지표가 매도 우위입니다. 진입보다 관망이 유리할 수 있습니다.';
    case 'strong_sell':
      return '추세·모멘텀·수급이 매도 쪽으로 강하게 정렬됐습니다.';
    default:
      return '뚜렷한 방향성이 없습니다. 돌파·거래량 확인 후 판단하세요.';
  }
}

export function buildChartSignalSnapshot(input: ChartSignalInput): ChartSignalSnapshot {
  // ?? [] 로 null/undefined 를 모두 방어한다. (destructuring 기본값은 undefined 만 막는다.)
  const candles = input.candles ?? [];
  const bids = input.bids ?? [];
  const asks = input.asks ?? [];
  const warnings = input.warnings ?? [];
  const sorted = candles.slice().sort((a, b) => a.time - b.time);

  if (sorted.length < MIN_CANDLES) {
    return {
      level: 'neutral',
      label: SIGNAL_LABELS.neutral,
      score: 0,
      summary: `신호 계산에 최소 ${MIN_CANDLES}개 봉이 필요합니다.`,
      metrics: [],
      insufficientData: true,
    };
  }

  const closes = sorted.map((candle) => candle.close);
  const lastClose = closes[closes.length - 1];
  const rsi = calculateRsi(closes);
  const smaFast = calculateSma(closes, SMA_FAST_PERIOD);
  const smaSlow = calculateSma(closes, SMA_SLOW_PERIOD);

  const trend = getTrendBias(lastClose, smaFast, smaSlow);
  const rsiSignal = getRsiBias(rsi);
  const volume = getVolumeBias(sorted);
  const orderbook = getOrderbookBias(bids, asks);

  const score = trend.score + rsiSignal.score + volume.score + orderbook.score;
  const level = getSignalLevel(score);

  const metrics: ChartSignalMetric[] = [
    { id: 'trend', label: '추세', value: trend.label, bias: trend.bias },
    { id: 'rsi', label: 'RSI', value: rsiSignal.label, bias: rsiSignal.bias },
    { id: 'volume', label: '거래량', value: volume.label, bias: volume.bias },
    { id: 'orderbook', label: '호가', value: orderbook.label, bias: orderbook.bias },
  ];

  if (smaFast !== undefined) {
    metrics.push({
      id: 'sma20',
      label: 'MA20',
      value: smaFast.toFixed(2),
      bias: lastClose > smaFast ? 'bullish' : lastClose < smaFast ? 'bearish' : 'neutral',
    });
  }

  metrics.push(...buildExtendedIndicatorMetrics(sorted));

  let summary = getSignalSummary(level);
  const warningSummary = formatWarningSummary(warnings);
  if (warningSummary) {
    summary = `${summary} 종목 경고: ${warningSummary}.`;
  }

  return {
    level,
    label: SIGNAL_LABELS[level],
    score,
    summary,
    metrics,
    insufficientData: false,
  };
}

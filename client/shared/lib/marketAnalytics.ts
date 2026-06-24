import type { CandleInterval, ChartCandle } from '../types';
import type { MicrostructureBias } from './marketMicrostructure';

export interface MarketMetric {
  id: string;
  label: string;
  value: string;
  bias: MicrostructureBias;
}

// 일봉 캔들에서 "전일(직전 거래일) 종가"를 고른다. 미국 거래일(ET) 기준으로 판단해야
// 자정을 넘긴 정규장(KST 새벽)에서도 오늘 캔들을 prevClose 로 잘못 쓰지 않는다.
export function resolvePreviousClose(dailyCandles: ChartCandle[], now = new Date()): number | undefined {
  if (dailyCandles.length === 0) return undefined;
  const sorted = [...dailyCandles].sort((a, b) => a.time - b.time);

  const etDate = (epochSec: number) =>
    new Date(epochSec * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const todayEt = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const last = sorted[sorted.length - 1];
  const lastIsToday = etDate(last.time) === todayEt;
  // 오늘 캔들이 있으면 그 직전(전일) 종가, 없으면 가장 최근 완료 세션의 종가.
  const prev = lastIsToday ? sorted[sorted.length - 2] : last;
  return prev?.close;
}

function formatSignedMoney(value: number, currency?: string) {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  if (currency === 'KRW') {
    return `${sign}₩${Math.abs(Math.round(value)).toLocaleString('ko-KR')}`;
  }
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

// 전일대비 등락(전일 종가 대비 현재가). 양수=상승 색, 음수=하락 색.
// currency 로 통화 표기(₩/$)를 분기한다(KR 조회 전용 지원). 기본 USD.
export function buildDayChangeMetric(
  previousClose?: number,
  currentPrice?: number,
  currency?: string
): MarketMetric {
  if (
    previousClose === undefined ||
    previousClose <= 0 ||
    currentPrice === undefined
  ) {
    return { id: 'day-change', label: '전일대비', value: '—', bias: 'neutral' };
  }
  const diff = currentPrice - previousClose;
  const rate = (diff / previousClose) * 100;
  const bias: MicrostructureBias = rate > 0 ? 'bullish' : rate < 0 ? 'bearish' : 'neutral';
  return {
    id: 'day-change',
    label: '전일대비',
    value: `${formatSignedPercent(rate)} (${formatSignedMoney(diff, currency)})`,
    bias,
  };
}

function getTodayCandles(candles: ChartCandle[], interval: CandleInterval) {
  if (candles.length === 0) return [];

  if (interval === '1d' || interval === '1w' || interval === '1M') {
    const last = candles[candles.length - 1];
    return last ? [last] : [];
  }

  const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
  return candles.filter(
    (candle) =>
      new Date(candle.time * 1000).toLocaleDateString('en-CA', {
        timeZone: 'Asia/Seoul',
      }) === todayKey
  );
}

function formatSignedPercent(value: number) {
  const sign = value > 0 ? '+' : value < 0 ? '' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function getPositionBias(percent: number): MicrostructureBias {
  if (percent >= 0.5) return 'bearish';
  if (percent <= -0.5) return 'bullish';
  return 'neutral';
}

export function buildDayPriceMetrics(
  candles: ChartCandle[],
  interval: CandleInterval,
  currentPrice?: number
): MarketMetric[] {
  const todayCandles = getTodayCandles(candles, interval);
  if (todayCandles.length === 0 || currentPrice === undefined) {
    return [
      { id: 'vwap', label: 'VWAP', value: '—', bias: 'neutral' },
      { id: 'day-range', label: '당일 고저', value: '—', bias: 'neutral' },
    ];
  }

  let volumeSum = 0;
  let vwapNumerator = 0;
  let dayHigh = -Infinity;
  let dayLow = Infinity;

  for (const candle of todayCandles) {
    const typical = (candle.high + candle.low + candle.close) / 3;
    vwapNumerator += typical * candle.volume;
    volumeSum += candle.volume;
    dayHigh = Math.max(dayHigh, candle.high);
    dayLow = Math.min(dayLow, candle.low);
  }

  const vwap = volumeSum > 0 ? vwapNumerator / volumeSum : undefined;
  const vwapDelta =
    vwap !== undefined && vwap > 0 ? ((currentPrice - vwap) / vwap) * 100 : undefined;

  const highDelta = dayHigh > 0 ? ((currentPrice - dayHigh) / dayHigh) * 100 : undefined;
  const lowDelta = dayLow > 0 ? ((currentPrice - dayLow) / dayLow) * 100 : undefined;

  return [
    {
      id: 'vwap',
      label: 'VWAP',
      value:
        vwapDelta !== undefined ? `${formatSignedPercent(vwapDelta)} (${vwap!.toFixed(2)})` : '—',
      bias: vwapDelta !== undefined ? getPositionBias(vwapDelta) : 'neutral',
    },
    {
      id: 'day-range',
      label: '당일 고저',
      value:
        highDelta !== undefined && lowDelta !== undefined
          ? `고 ${formatSignedPercent(highDelta)} · 저 ${formatSignedPercent(lowDelta)}`
          : '—',
      bias:
        highDelta !== undefined && lowDelta !== undefined
          ? Math.abs(highDelta) < Math.abs(lowDelta)
            ? 'bearish'
            : Math.abs(lowDelta) < Math.abs(highDelta)
              ? 'bullish'
              : 'neutral'
          : 'neutral',
    },
  ];
}

import type { CandleInterval, ChartCandle } from '../types';
import type { MicrostructureBias } from './marketMicrostructure';
import { usdMaxFractionDigits } from './formatHoldings';

export interface MarketMetric {
  id: string;
  label: string;
  value: string;
  bias: MicrostructureBias;
}

// 일봉 캔들에서 "전일(직전 거래일) 종가"를 고른다. 미국 거래일(ET) 기준으로 판단해야
// 자정을 넘긴 정규장(KST 새벽)에서도 오늘 캔들을 prevClose 로 잘못 쓰지 않는다.
/** 해당 세션(ET 날짜)의 애프터마켓 종료 시각(20:00 ET)의 epoch(ms). */
function sessionCutoffMs(epochSec: number): number {
  const [y, m, d] = new Date(epochSec * 1000)
    .toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    .split('-')
    .map(Number);
  // 그 날짜의 ET 오프셋(EDT -4 / EST -5)을 역검증으로 판별해 20:00 ET 의 UTC epoch 을 만든다.
  for (const offset of [4, 5]) {
    const guess = Date.UTC(y, m - 1, d, 20 + offset, 0, 0);
    const backHour = new Date(guess).toLocaleTimeString('en-GB', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      hour12: false,
    });
    if (backHour === '20') return guess;
  }
  return Date.UTC(y, m - 1, d + 1, 0, 0, 0); // 이례적 폴백
}

/**
 * 등락률 기준 종가 — 토스와 동일하게 '애프터마켓 종료(20:00 ET = 데이장 시작 09/10시 KST)'
 * 시점에 방금 끝난 세션의 종가로 롤오버한다. (ET 달력 자정 기준이 아니라 세션 사이클 기준 —
 * 매일 09:00~13:00 KST 구간에 토스와 어긋나던 문제 수정)
 */
export function resolvePreviousClose(dailyCandles: ChartCandle[], now = new Date()): number | undefined {
  if (dailyCandles.length === 0) return undefined;
  const sorted = [...dailyCandles].sort((a, b) => a.time - b.time);
  const nowMs = now.getTime();
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    if (sessionCutoffMs(sorted[i].time) <= nowMs) return sorted[i].close;
  }
  return undefined;
}

function formatSignedMoney(value: number, currency?: string) {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  if (currency === 'KRW') {
    return `${sign}₩${Math.abs(Math.round(value)).toLocaleString('ko-KR')}`;
  }
  // 단가 차액 → $1 미만(저가주)만 2~4자리(서브-페니 변동 보존), $1 이상은 2자리.
  const formatted = Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: usdMaxFractionDigits(value),
  });
  return `${sign}$${formatted}`;
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
    // 토스 관례와 동일하게 금액 먼저, 등락률은 괄호 안에.
    value: `${formatSignedMoney(diff, currency)} (${formatSignedPercent(rate)})`,
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

export interface DaySummary {
  open: number;
  high: number;
  low: number;
  volume: number;
  vwap?: number;
}

/**
 * 오늘 세션의 시가·고저·거래량·VWAP (호가창 정보 컬럼용, 절대값).
 * 분봉은 KST 오늘 캔들 필터, 일/주/월봉은 마지막 봉 기준 — 로드된 캔들 범위 내 근사치.
 */
export function buildDaySummary(
  candles: ChartCandle[],
  interval: CandleInterval
): DaySummary | null {
  const todayCandles = getTodayCandles(candles, interval);
  if (todayCandles.length === 0) return null;

  const sorted = [...todayCandles].sort((a, b) => a.time - b.time);
  let high = -Infinity;
  let low = Infinity;
  let volume = 0;
  let vwapNumerator = 0;
  for (const candle of sorted) {
    high = Math.max(high, candle.high);
    low = Math.min(low, candle.low);
    volume += candle.volume;
    vwapNumerator += ((candle.high + candle.low + candle.close) / 3) * candle.volume;
  }
  return {
    open: sorted[0].open,
    high,
    low,
    volume,
    vwap: volume > 0 ? vwapNumerator / volume : undefined,
  };
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

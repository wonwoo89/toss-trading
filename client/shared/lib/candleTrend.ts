import type { ChartCandle } from '../types';

export type TrendState = 'up' | 'down' | 'flat';

export interface CandleTrendResult {
  state: TrendState;
  /** 추세 강도 0~1 (바디 모멘텀·기울기 기반, 표시용). */
  strength: number;
  /** state 방향을 지지하는 최근 연속 확정봉 수. */
  confirmedBars: number;
  /** 상승 추세가 충분히 확정됨(보수적 진입 게이트). */
  confirmedUp: boolean;
  /** 하락 추세가 충분히 확정됨. */
  confirmedDown: boolean;
  /** 계산 가능했는지(완성봉 부족 시 false). */
  available: boolean;
}

const EMA_PERIOD = 20;
// 보수적: 최근 N개 '완성봉'의 음/양봉 추세가 정렬돼야 진입 확정.
const CONFIRM_BARS = 3;
// EMA 기울기 최소(봉당, 가격 대비 비율). 횡보를 추세로 오인하지 않도록.
const SLOPE_EPS = 0.0005;

function emaSeries(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i += 1) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

const EMPTY: CandleTrendResult = {
  state: 'flat',
  strength: 0,
  confirmedBars: 0,
  confirmedUp: false,
  confirmedDown: false,
  available: false,
};

/**
 * 차트의 음/양봉 추세를 '완성봉'만으로 계산해 매수/매도 진입 확정 여부를 판단한다.
 *
 * 핵심(노이즈 제거):
 *  - 형성 중인 현재봉(마지막 봉)은 제외 → 틱마다 출렁이는 미완성봉 영향 차단.
 *    같은 봉이 형성되는 동안 결과가 불변이라, 신호는 '봉 마감' 시점에만 바뀐다.
 *  - 보수적 확정: 가격이 EMA 위/아래 + EMA 기울기 방향 + 최근 N개 완성봉의 음/양봉이
 *    추세 방향으로 정렬(+ 순바디 부호 일치)될 때만 up/down 확정. 그 외 flat(관망).
 *
 * 순수 함수 — 완성봉 히스토리에만 의존하므로 워커/동기 폴백 모두 동일하게 동작.
 */
export function computeCandleTrend(
  candles: ChartCandle[],
  options?: { confirmBars?: number }
): CandleTrendResult {
  const confirmBars = options?.confirmBars ?? CONFIRM_BARS;
  if (!candles || candles.length < EMA_PERIOD + confirmBars + 1) return EMPTY;

  const sorted = candles.slice().sort((a, b) => a.time - b.time);
  // 마지막(형성 중) 봉 제외 → 완성봉만 사용.
  const closed = sorted.slice(0, -1);
  if (closed.length < EMA_PERIOD + confirmBars) return EMPTY;

  const closes = closed.map((c) => c.close);
  const ema = emaSeries(closes, EMA_PERIOD);
  const n = closed.length;
  const last = n - 1;
  const emaNow = ema[last];
  const emaPrev = ema[last - confirmBars];
  const closeNow = closes[last];

  const slope = emaPrev > 0 ? (emaNow - emaPrev) / emaPrev / confirmBars : 0;

  // 최근 confirmBars 개 완성봉의 방향(음/양봉) + EMA 상대 위치 + 순바디.
  let upBars = 0;
  let downBars = 0;
  let netBody = 0;
  for (let i = n - confirmBars; i < n; i += 1) {
    const c = closed[i];
    const denom = c.open || closeNow || 1;
    netBody += (c.close - c.open) / denom;
    if (c.close > c.open && c.close >= ema[i]) upBars += 1;
    else if (c.close < c.open && c.close <= ema[i]) downBars += 1;
  }

  const priceAbove = closeNow > emaNow;
  const priceBelow = closeNow < emaNow;

  let state: TrendState = 'flat';
  if (priceAbove && slope > SLOPE_EPS && upBars >= confirmBars - 1 && netBody > 0) {
    state = 'up';
  } else if (priceBelow && slope < -SLOPE_EPS && downBars >= confirmBars - 1 && netBody < 0) {
    state = 'down';
  }

  const strength = clamp01(Math.abs(netBody) * 40 + Math.abs(slope) * 150);
  const confirmedBars = state === 'up' ? upBars : state === 'down' ? downBars : 0;

  return {
    state,
    strength,
    confirmedBars,
    confirmedUp: state === 'up',
    confirmedDown: state === 'down',
    available: true,
  };
}

import type { ChartCandle } from '../types';

export type SupertrendDir = 'up' | 'down';

export interface SupertrendPoint {
  time: number;
  value: number;
  dir: SupertrendDir;
}

const ATR_PERIOD = 10;
const MULTIPLIER = 3;

/**
 * 슈퍼트렌드(Supertrend) — ATR 기반 추세추종 지표.
 *  - 밴드: HL2 ± (multiplier × ATR), 추세 방향으로만 좁혀지게 락 처리.
 *  - 종가가 상단 밴드 상향 돌파 → 상승(선=하단), 하단 밴드 하향 이탈 → 하락(선=상단).
 * 입력 candles 는 시간 오름차순 정렬을 가정한다.
 */
export function calculateSupertrendSeries(
  candles: ChartCandle[],
  period = ATR_PERIOD,
  multiplier = MULTIPLIER
): SupertrendPoint[] {
  if (!candles || candles.length < period + 1) return [];
  const c = candles;
  const n = c.length;

  // True Range
  const tr: number[] = new Array(n);
  tr[0] = c[0].high - c[0].low;
  for (let i = 1; i < n; i += 1) {
    tr[i] = Math.max(
      c[i].high - c[i].low,
      Math.abs(c[i].high - c[i - 1].close),
      Math.abs(c[i].low - c[i - 1].close)
    );
  }

  // ATR — Wilder RMA. period 구간 평균으로 시드 후 점화식.
  const atr: number[] = new Array(n).fill(NaN);
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += tr[i];
  atr[period - 1] = seed / period;
  for (let i = period; i < n; i += 1) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }

  const out: SupertrendPoint[] = [];
  let prevFinalUpper = 0;
  let prevFinalLower = 0;
  let prevDir: SupertrendDir = 'up';
  let started = false;

  for (let i = period - 1; i < n; i += 1) {
    const a = atr[i];
    if (!Number.isFinite(a)) continue;
    const hl2 = (c[i].high + c[i].low) / 2;
    const upperBasic = hl2 + multiplier * a;
    const lowerBasic = hl2 - multiplier * a;
    const prevClose = i > 0 ? c[i - 1].close : c[i].close;

    let finalUpper: number;
    let finalLower: number;
    if (!started) {
      finalUpper = upperBasic;
      finalLower = lowerBasic;
    } else {
      finalUpper =
        upperBasic < prevFinalUpper || prevClose > prevFinalUpper ? upperBasic : prevFinalUpper;
      finalLower =
        lowerBasic > prevFinalLower || prevClose < prevFinalLower ? lowerBasic : prevFinalLower;
    }

    let dir: SupertrendDir;
    if (!started) {
      dir = c[i].close >= hl2 ? 'up' : 'down';
    } else if (prevDir === 'down') {
      dir = c[i].close > finalUpper ? 'up' : 'down';
    } else {
      dir = c[i].close < finalLower ? 'down' : 'up';
    }

    out.push({ time: c[i].time, value: dir === 'up' ? finalLower : finalUpper, dir });

    prevFinalUpper = finalUpper;
    prevFinalLower = finalLower;
    prevDir = dir;
    started = true;
  }

  return out;
}

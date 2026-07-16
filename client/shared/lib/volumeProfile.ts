import type { ChartCandle } from '../types';

export interface VolumeProfileBin {
  priceLow: number;
  priceHigh: number;
  /** 양봉(종가≥시가) 캔들에서 배분된 거래량. */
  upVolume: number;
  /** 음봉 캔들에서 배분된 거래량. */
  downVolume: number;
}

export interface VolumeProfile {
  bins: VolumeProfileBin[];
  maxTotal: number;
}

/** 토스 '매물대분석 30'과 동일한 기본 구간 수. */
export const VOLUME_PROFILE_BINS = 30;

/**
 * 매물대(볼륨 프로파일) — 로드된 캔들 전체의 가격 범위를 binCount 구간으로 나누고,
 * 각 캔들의 거래량을 고가~저가 범위와 겹치는 구간에 비례 배분한다.
 * 양봉/음봉 거래량을 분리해 매수·매도 우위 색을 표현할 수 있게 한다.
 */
export function buildVolumeProfile(
  candles: ChartCandle[],
  binCount = VOLUME_PROFILE_BINS
): VolumeProfile | null {
  if (candles.length < 2 || binCount < 1) return null;

  let min = Infinity;
  let max = -Infinity;
  for (const candle of candles) {
    if (candle.low < min) min = candle.low;
    if (candle.high > max) max = candle.high;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;

  const step = (max - min) / binCount;
  const bins: VolumeProfileBin[] = Array.from({ length: binCount }, (_, i) => ({
    priceLow: min + i * step,
    priceHigh: min + (i + 1) * step,
    upVolume: 0,
    downVolume: 0,
  }));

  for (const candle of candles) {
    const lo = candle.low;
    const hi = Math.max(candle.high, lo + step * 1e-6); // 고가=저가(도지) 방어
    const span = hi - lo;
    const isUp = candle.close >= candle.open;
    const startIdx = Math.max(0, Math.min(binCount - 1, Math.floor((lo - min) / step)));
    const endIdx = Math.max(0, Math.min(binCount - 1, Math.ceil((hi - min) / step) - 1));
    for (let i = startIdx; i <= endIdx; i += 1) {
      const overlap = Math.min(hi, bins[i].priceHigh) - Math.max(lo, bins[i].priceLow);
      if (overlap <= 0) continue;
      const share = candle.volume * (overlap / span);
      if (isUp) bins[i].upVolume += share;
      else bins[i].downVolume += share;
    }
  }

  const maxTotal = Math.max(1, ...bins.map((b) => b.upVolume + b.downVolume));
  return { bins, maxTotal };
}

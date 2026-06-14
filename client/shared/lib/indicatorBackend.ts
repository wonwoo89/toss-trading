import type { ChartCandle } from '../types';

/**
 * 지표 계산 가속 백엔드. 기본은 비어 있고(=JS 로 계산), Web Worker 가 시작 시 WASM 구현을
 * 등록한다. 메인 스레드는 등록하지 않으므로 동작이 전혀 바뀌지 않는다.
 *
 * 각 함수는 가속 결과를 돌려주거나, 가속 불가/데이터 부족 시 null 을 돌려준다.
 * null 이면 호출 측이 기존 JS 구현으로 폴백한다.
 */
export interface IndicatorBackend {
  /** close 배열에서 window(period)별 [upper, middle, lower] 평탄화 배열을 반환. */
  bollingerWindows?: (closes: number[], period: number, k: number) => number[] | null;
  /** 캔들 배열에서 ATR(period) 값을 반환. */
  atrFromCandles?: (candles: ChartCandle[], period: number) => number | null;
}

let backend: IndicatorBackend = {};

export function setIndicatorBackend(next: IndicatorBackend): void {
  backend = next;
}

export function getIndicatorBackend(): IndicatorBackend {
  return backend;
}

import initWasm from './indicators.wasm?init';
import type { ChartCandle } from '../../types';

// AssemblyScript 로 컴파일한 지표 커널(Bollinger·ATR)을 감싸는 래퍼.
// JS↔WASM 경계는 선형 메모리(Float64Array 뷰)로 직접 주고받아 직렬화 비용이 없다.
// 버퍼는 1회 할당 후 재사용하며, 용량을 초과하는 입력이 올 때만 재할당한다.

interface IndicatorExports {
  memory: WebAssembly.Memory;
  alloc(size: number): number;
  bollinger(inPtr: number, len: number, period: number, k: number, outPtr: number): number;
  atr(highPtr: number, lowPtr: number, closePtr: number, len: number, period: number): number;
}

let exports: IndicatorExports | null = null;
let initPromise: Promise<boolean> | null = null;

let capacity = 0;
let aPtr = 0; // 입력 A (closes 또는 high)
let bPtr = 0; // 입력 B (low)
let cPtr = 0; // 입력 C (close)
let outPtr = 0; // Bollinger 출력 (window 당 f64 3개)

function ensureCapacity(len: number): boolean {
  const ex = exports;
  if (!ex) return false;
  if (len <= capacity) return true;

  const next = Math.max(len, 256);
  aPtr = ex.alloc(next * 8);
  bPtr = ex.alloc(next * 8);
  cPtr = ex.alloc(next * 8);
  outPtr = ex.alloc(next * 3 * 8);
  capacity = next;
  return true;
}

/** WASM 커널을 1회 인스턴스화한다. 성공 여부를 반환하며, 실패해도 호출 측은 JS 로 폴백한다. */
export function initIndicatorsWasm(): Promise<boolean> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const instance = await initWasm({
        env: { abort: () => { throw new Error('indicators wasm abort'); } },
      });
      exports = instance.exports as unknown as IndicatorExports;
      return true;
    } catch {
      exports = null;
      return false;
    }
  })();

  return initPromise;
}

/** close 배열의 볼린저 밴드를 계산해 window 당 [upper, middle, lower] 평탄화 배열로 반환. */
export function bollingerWindowsWasm(closes: number[], period: number, k: number): number[] | null {
  const ex = exports;
  if (!ex || period <= 0 || closes.length < period) return null;
  if (!ensureCapacity(closes.length)) return null;

  // alloc 직후 메모리가 grow 했을 수 있어 뷰를 새로 만든다.
  new Float64Array(ex.memory.buffer).set(closes, aPtr >>> 3);
  const count = ex.bollinger(aPtr, closes.length, period, k, outPtr);
  return Array.from(new Float64Array(ex.memory.buffer, outPtr, count * 3));
}

/** 캔들 배열(시간 정렬 후 high/low/close)의 ATR(period)을 계산. 데이터 부족/NaN 이면 null. */
export function atrFromCandlesWasm(candles: ChartCandle[], period: number): number | null {
  const ex = exports;
  if (!ex || period <= 0 || candles.length < period + 1) return null;
  if (!ensureCapacity(candles.length)) return null;

  const sorted = candles.slice().sort((a, b) => a.time - b.time);
  const mem = new Float64Array(ex.memory.buffer);
  const aBase = aPtr >>> 3;
  const bBase = bPtr >>> 3;
  const cBase = cPtr >>> 3;
  for (let i = 0; i < sorted.length; i += 1) {
    mem[aBase + i] = sorted[i].high;
    mem[bBase + i] = sorted[i].low;
    mem[cBase + i] = sorted[i].close;
  }

  const value = ex.atr(aPtr, bPtr, cPtr, sorted.length, period);
  return Number.isNaN(value) ? null : value;
}

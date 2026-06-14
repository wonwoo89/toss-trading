// AssemblyScript 지표 핫 루프. JS 의 calculateBollingerBandSeries / calculateAtr 와
// 동일한 수식을 선형 메모리(raw f64 load/store) 위에서 계산한다.
//
// 메모리 마샬링: JS 가 alloc() 으로 버퍼를 받아 Float64Array 뷰로 입력을 쓰고, 결과를
// 다시 뷰로 읽는다. 객체/배열을 경계로 넘기지 않아 직렬화 비용이 없다.

/** size 바이트를 힙에서 할당해 포인터를 돌려준다(stub 런타임 bump 할당). */
export function alloc(size: i32): usize {
  return heap.alloc(<usize>size);
}

/**
 * 볼린저 밴드. inPtr 의 close f64 배열(len 개)을 읽어 window(period)마다
 * [upper, middle, lower] 세 쌍을 outPtr 에 평탄화해 쓴다. 작성한 포인트 수를 반환.
 * (모집단 표준편차 = variance/period, JS 구현과 동일)
 */
export function bollinger(inPtr: usize, len: i32, period: i32, k: f64, outPtr: usize): i32 {
  if (period <= 0 || len < period) return 0;

  let count = 0;
  for (let i = period - 1; i < len; i++) {
    let sum: f64 = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += load<f64>(inPtr + (<usize>j << 3));
    }
    const mean = sum / <f64>period;

    let varSum: f64 = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = load<f64>(inPtr + (<usize>j << 3)) - mean;
      varSum += d * d;
    }
    const sd = Math.sqrt(varSum / <f64>period);

    const base = outPtr + (<usize>(count * 3) << 3);
    store<f64>(base, mean + k * sd);
    store<f64>(base + 8, mean);
    store<f64>(base + 16, mean - k * sd);
    count++;
  }

  return count;
}

/**
 * ATR. 정렬된 high/low/close f64 배열(len 개)에서 마지막 period 개 true range 의 평균.
 * 데이터 부족 시 NaN. (JS 구현은 전체 TR 후 마지막 period 평균 — 결과 동일)
 */
export function atr(
  highPtr: usize,
  lowPtr: usize,
  closePtr: usize,
  len: i32,
  period: i32
): f64 {
  if (period <= 0 || len < period + 1) return NaN;

  let sum: f64 = 0;
  let counted = 0;
  for (let i = len - period; i < len; i++) {
    const h = load<f64>(highPtr + (<usize>i << 3));
    const l = load<f64>(lowPtr + (<usize>i << 3));
    const pc = load<f64>(closePtr + (<usize>(i - 1) << 3));
    const tr = Math.max(h - l, Math.max(Math.abs(h - pc), Math.abs(l - pc)));
    sum += tr;
    counted++;
  }

  return sum / <f64>counted;
}

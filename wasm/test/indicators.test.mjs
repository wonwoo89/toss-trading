// WASM 지표 커널 회귀 테스트: Node 의 WebAssembly 로 .wasm 을 인스턴스화해 JS 기준
// 구현과 결과가 일치하는지 검증한다(브라우저 불필요).
//   실행: node wasm/test/indicators.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(here, '../../client/shared/lib/wasm/indicators.wasm');

const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {
  env: { abort: () => { throw new Error('wasm abort'); } },
});
const ex = instance.exports;

// ---- 기준 JS 구현 (앱의 calculateBollingerBandSeries / calculateAtr 와 동일 수식) ----
function jsBollinger(closes, period, k) {
  const out = [];
  for (let i = period - 1; i < closes.length; i += 1) {
    const w = closes.slice(i - period + 1, i + 1);
    const mean = w.reduce((s, v) => s + v, 0) / period;
    const variance = w.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    out.push([mean + k * sd, mean, mean - k * sd]);
  }
  return out;
}
function jsAtr(high, low, close, period) {
  const trs = [];
  for (let i = 1; i < close.length; i += 1) {
    trs.push(
      Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]))
    );
  }
  const recent = trs.slice(-period);
  return recent.reduce((s, v) => s + v, 0) / recent.length;
}

// ---- WASM 래퍼 (선형 메모리 마샬링) ----
const f64 = () => new Float64Array(ex.memory.buffer);
function wasmBollinger(closes, period, k) {
  const inPtr = ex.alloc(closes.length * 8);
  const outPtr = ex.alloc(closes.length * 3 * 8);
  f64().set(closes, inPtr >>> 3);
  const count = ex.bollinger(inPtr, closes.length, period, k, outPtr);
  const view = new Float64Array(ex.memory.buffer, outPtr, count * 3);
  const out = [];
  for (let i = 0; i < count; i += 1) out.push([view[i * 3], view[i * 3 + 1], view[i * 3 + 2]]);
  return out;
}
function wasmAtr(high, low, close, period) {
  const hp = ex.alloc(high.length * 8);
  const lp = ex.alloc(low.length * 8);
  const cp = ex.alloc(close.length * 8);
  const m = f64();
  m.set(high, hp >>> 3);
  m.set(low, lp >>> 3);
  m.set(close, cp >>> 3);
  return ex.atr(hp, lp, cp, close.length, period);
}

// ---- 데이터 & 검증 ----
const closes = Array.from({ length: 120 }, (_, i) => 100 + 10 * Math.sin(i / 5) + (i % 7) * 0.3);
const high = closes.map((c, i) => c + 1 + (i % 3) * 0.2);
const low = closes.map((c, i) => c - 1 - (i % 4) * 0.15);

const eps = 1e-9;
let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const jb = jsBollinger(closes, 20, 2);
const wb = wasmBollinger(closes, 20, 2);
let maxDiff = 0;
for (let i = 0; i < jb.length; i += 1) {
  for (let t = 0; t < 3; t += 1) maxDiff = Math.max(maxDiff, Math.abs(jb[i][t] - wb[i][t]));
}
check('bollinger length', jb.length === wb.length, `js=${jb.length} wasm=${wb.length}`);
check('bollinger values', maxDiff < eps, `maxDiff=${maxDiff.toExponential(2)}`);

const ja = jsAtr(high, low, closes, 14);
const wa = wasmAtr(high, low, closes, 14);
check('atr value', Math.abs(ja - wa) < eps, `js=${ja.toFixed(8)} wasm=${wa.toFixed(8)}`);

check('bollinger insufficient → 0 points', wasmBollinger([1, 2, 3], 20, 2).length === 0);
check('atr insufficient → NaN', Number.isNaN(ex.atr(ex.alloc(8), ex.alloc(8), ex.alloc(8), 2, 14)));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll WASM indicator checks passed.');

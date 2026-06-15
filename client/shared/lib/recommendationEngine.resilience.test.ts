// 추천 엔진 견고성 회귀 테스트: 종목 전환 과도기에 들어올 수 있는 비정상 입력
// (null/undefined/빈 배열/경계 길이)에서 compute 함수가 절대 throw 하지 않아야 한다.
//
// 배경: 워커는 compute 가 throw 하면 응답을 보내지 못하고, 그러면 useWorkerCompute 의
// inFlightRef 가 stuck 되어 추천 패널이 동결된다(종목 전환 시 일부 종목만 깨지던 버그).
// 워커에 try/catch 를 넣어 1차 방어하고, 여기서 엔진 자체가 입력에 견고함을 보장한다.
//
//   실행: npx tsx client/shared/lib/recommendationEngine.resilience.test.ts
import {
  computeChartSignal,
  computeOrderRecommendations,
  type OrderRecommendationInput,
} from './recommendationEngine';
import type { ChartSignalInput } from './chartSignals';

const mkCandles = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    time: i,
    open: 100 + Math.sin(i / 5),
    high: 101 + Math.sin(i / 5),
    low: 99 + Math.sin(i / 5),
    close: 100 + Math.sin(i / 5),
    volume: 1000 + (i % 7) * 10,
  }));

let failures = 0;
function expectNoThrow(name: string, fn: () => unknown) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---- computeOrderRecommendations: 비정상/과도기 입력 ----
const orderCases: Array<[string, OrderRecommendationInput]> = [
  ['order: 빈 객체', { side: 'BUY' } as OrderRecommendationInput],
  ['order: candles null', { side: 'BUY', candles: null } as unknown as OrderRecommendationInput],
  ['order: bids null', { side: 'BUY', candles: mkCandles(30), bids: null } as unknown as OrderRecommendationInput],
  ['order: asks null', { side: 'BUY', candles: mkCandles(30), asks: null } as unknown as OrderRecommendationInput],
  ['order: trades null', { side: 'BUY', candles: mkCandles(30), trades: null } as unknown as OrderRecommendationInput],
  ['order: openOrders null', { side: 'SELL', candles: mkCandles(30), openOrders: null } as unknown as OrderRecommendationInput],
  ['order: 모든 배열 null', { side: 'BUY', candles: null, bids: null, asks: null, trades: null, openOrders: null } as unknown as OrderRecommendationInput],
  ['order: 빈 배열', { side: 'BUY', currentPrice: 100, candles: [], bids: [], asks: [], trades: [], openOrders: [] }],
  ['order: 경계 길이(15)', { side: 'BUY', currentPrice: 100, candles: mkCandles(15) }],
  ['order: NaN price', { side: 'SELL', currentPrice: NaN, candles: mkCandles(30) }],
  ['order: 풀 입력', { side: 'BUY', currentPrice: 100, candles: mkCandles(60), bids: [{ price: 99, quantity: 5 }], asks: [{ price: 101, quantity: 5 }], trades: [{ price: 100, quantity: 1, timestamp: '1' }], buyingPower: 5000, maxOrderQuantity: 49, buyMaxForRec: 49, sellMaxForRec: 0 }],
];
for (const [name, input] of orderCases) {
  expectNoThrow(name, () => computeOrderRecommendations(input));
}

// ---- computeChartSignal: 비정상/과도기 입력 ----
const signalCases: Array<[string, ChartSignalInput]> = [
  ['signal: candles undefined', {} as ChartSignalInput],
  ['signal: candles null', { candles: null } as unknown as ChartSignalInput],
  ['signal: bids/asks null', { candles: mkCandles(30), bids: null, asks: null } as unknown as ChartSignalInput],
  ['signal: warnings null', { candles: mkCandles(30), warnings: null } as unknown as ChartSignalInput],
  ['signal: 빈 candles', { candles: [] }],
  ['signal: 경계 길이(15)', { candles: mkCandles(15) }],
  ['signal: 풀 입력', { candles: mkCandles(60), bids: [{ quantity: 5 }], asks: [{ quantity: 5 }], warnings: [] }],
];
for (const [name, input] of signalCases) {
  expectNoThrow(name, () => computeChartSignal(input));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll recommendation engine resilience checks passed.');

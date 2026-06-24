/**
 * 국내(KR) 주식 API 지원 여부 진단 프로브 (일회성).
 * 앱 동작에 영향 없음 — 토스 Open API 에 KR/US 종목을 같은 엔드포인트로 호출해 비교한다.
 *
 *   서버(.env 있는 곳)에서:  pnpm probe:kr           # 기본 005930(삼성전자) vs AAPL
 *                           pnpm probe:kr 000660    # KR 심볼 지정
 *                           pnpm probe:kr 005930 TSLA
 *
 * 판단: 국내 stocks/prices 가 currency:"KRW" + 실제 시세를 주면 → 지원 O.
 *       국내만 빈 배열/404/에러면 → 미지원(또는 다른 엔드포인트 필요).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { warmUpAuth } from '../lib/auth.js';
import { tossRequest } from '../lib/toss-client.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(rootDir, '.env') });

const krSymbol = process.argv[2] ?? '005930'; // 삼성전자
const usSymbol = process.argv[3] ?? 'AAPL';

function snippet(data: unknown, n = 700) {
  try {
    return JSON.stringify(data).slice(0, n);
  } catch {
    return String(data);
  }
}

async function probe(label: string, fn: () => Promise<unknown>) {
  try {
    const data = await fn();
    console.log(`\n✅ ${label}`);
    console.log('   ', snippet(data));
  } catch (e) {
    console.log(`\n❌ ${label}`);
    console.log('   ', e instanceof Error ? e.message : String(e));
  }
}

async function runFor(symbol: string, marketLabel: string) {
  console.log(`\n================ ${marketLabel}: ${symbol} ================`);
  await probe(`stocks (${symbol})`, () =>
    tossRequest({ path: '/api/v1/stocks', query: { symbols: symbol } })
  );
  await probe(`prices (${symbol})`, () =>
    tossRequest({ path: '/api/v1/prices', query: { symbols: symbol } })
  );
  await probe(`orderbook (${symbol})`, () =>
    tossRequest({ path: '/api/v1/orderbook', query: { symbol } })
  );
  await probe(`candles 1m x5 (${symbol})`, () =>
    tossRequest({
      path: '/api/v1/candles',
      query: { symbol, interval: '1m', count: 5, adjusted: true },
    })
  );
}

try {
  await warmUpAuth();
  console.log('auth: OK');
} catch (e) {
  console.error('auth FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
}

await runFor(usSymbol, '해외(US, 비교용)');
await runFor(krSymbol, '국내(KR, 검증대상)');

// 국내 장 캘린더 엔드포인트 존재 여부(현재 앱은 /market-calendar/US 만 사용)
await probe('market-calendar/KR', () => tossRequest({ path: '/api/v1/market-calendar/KR' }));

console.log('\n— 판단 기준 —');
console.log('국내 stocks/prices 가 currency:"KRW" + 실제 시세를 주면 → 국내주식 지원 O');
console.log('국내만 빈 배열/404/에러면 → 미지원(또는 다른 엔드포인트/표기 필요)');

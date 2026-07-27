/**
 * 주문폼 입력 방식(가격/수익률/금액)과 목표 수익률 선택을
 * 종목 전환·새로고침에도 유지하기 위한 localStorage 저장.
 */

export type OrderEntryMode = 'price' | 'profit' | 'amount';

const MODE_KEY = 'toss-trading:order-entry-mode';
/** 구버전 '금액 주문' 체크박스 저장 키 — 1회성 마이그레이션 용도. */
const LEGACY_AMOUNT_KEY = 'toss-trading:amount-order';
const PROFIT_RATE_KEY = 'toss-trading:profit-target-rate';

export function getStoredOrderEntryMode(): OrderEntryMode {
  try {
    const stored = localStorage.getItem(MODE_KEY);
    if (stored === 'price' || stored === 'profit' || stored === 'amount') return stored;
    // 구버전(금액 주문 체크박스) 저장값 호환
    if (localStorage.getItem(LEGACY_AMOUNT_KEY) === '1') return 'amount';
  } catch {
    // ignore read errors
  }
  return 'price';
}

export function setStoredOrderEntryMode(mode: OrderEntryMode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // ignore write errors
  }
}

export function getStoredProfitTargetRate(): number {
  try {
    const n = Number(localStorage.getItem(PROFIT_RATE_KEY));
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    // ignore read errors
  }
  return 1;
}

export function setStoredProfitTargetRate(rate: number) {
  try {
    localStorage.setItem(PROFIT_RATE_KEY, String(rate));
  } catch {
    // ignore write errors
  }
}

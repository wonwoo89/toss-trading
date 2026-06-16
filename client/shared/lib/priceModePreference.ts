export type PriceMode = 'limit' | 'current' | 'market';

const STORAGE_KEY = 'toss-trading:price-mode';
const VALID = new Set<PriceMode>(['limit', 'current', 'market']);

/** 주문폼 가격 모드(지정가/현재가/시장가) 선택을 새로고침에도 유지하기 위한 localStorage 저장. */
export function getStoredPriceMode(): PriceMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && VALID.has(stored as PriceMode)) return stored as PriceMode;
  } catch {
    // ignore read errors
  }
  return 'limit';
}

export function setStoredPriceMode(mode: PriceMode) {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // ignore write errors
  }
}

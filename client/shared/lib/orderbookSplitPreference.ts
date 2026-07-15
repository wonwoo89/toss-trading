const STORAGE_KEY = 'toss-trading:orderbook-split-ratio';

/** 호가 섹션이 주문 컬럼에서 차지하는 높이 비율의 허용 범위. */
export const ORDERBOOK_SPLIT_MIN = 0.15;
export const ORDERBOOK_SPLIT_MAX = 0.85;

export function clampOrderbookSplitRatio(ratio: number): number {
  return Math.min(ORDERBOOK_SPLIT_MAX, Math.max(ORDERBOOK_SPLIT_MIN, ratio));
}

/**
 * 데스크톱 주문 컬럼의 호가/주문폼 분할 비율(호가 몫, 0.15~0.85).
 * null 이면 사용자가 조절한 적 없음 → 기본 레이아웃(주문폼 자연 높이 + 호가 나머지).
 */
export function getStoredOrderbookSplitRatio(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return null;
    return clampOrderbookSplitRatio(parsed);
  } catch {
    return null;
  }
}

export function setStoredOrderbookSplitRatio(ratio: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(clampOrderbookSplitRatio(ratio)));
  } catch {
    // ignore storage write errors
  }
}

export function clearStoredOrderbookSplitRatio() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore storage write errors
  }
}

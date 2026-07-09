const STORAGE_KEY = 'toss-trading:order-quantity-percent';

/**
 * 주문폼 수량 비율(%) 선택값 영속. 마지막 선택을 기억해 종목 전환·재접속 후에도
 * 미리 선택돼 있게 한다 → 직접 매수/매도가 1탭으로 가능(빠른 주문).
 */
export function getStoredQuantityPercent(): number | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 && n <= 100 ? n : undefined;
  } catch {
    return undefined;
  }
}

export function setStoredQuantityPercent(percent: number | undefined) {
  try {
    if (percent === undefined) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, String(percent));
  } catch {
    // ignore storage write errors
  }
}

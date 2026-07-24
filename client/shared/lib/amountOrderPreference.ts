const STORAGE_KEY = 'toss-trading:amount-order';

/** 주문폼 '금액 주문' 토글 선택을 종목 전환·새로고침에도 유지하기 위한 localStorage 저장. */
export function getStoredAmountOrder(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setStoredAmountOrder(enabled: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // ignore write errors
  }
}

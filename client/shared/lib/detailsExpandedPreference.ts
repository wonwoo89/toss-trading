const STORAGE_KEY = 'toss-trading:chart-details-expanded';

/**
 * 모바일에서 차트 하단 상세지표의 펼침/접힘 상태. 종목 전환 시 MarketPanel 이 key 로
 * 리마운트돼도 유지되도록 localStorage 에 영속한다. (데스크톱은 항상 펼침이라 무관)
 * 기본값은 접힘(false).
 */
export function getStoredDetailsExpanded(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setStoredDetailsExpanded(expanded: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, expanded ? 'true' : 'false');
  } catch {
    // ignore storage write errors
  }
}

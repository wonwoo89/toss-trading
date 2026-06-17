const STORAGE_KEY = 'toss-trading:chart-bollinger-visible';

/**
 * 차트 볼린저밴드 표시 여부. 종목 전환 시 MarketPanel 이 key 로 리마운트돼도 유지되도록
 * localStorage 에 영속한다. 기본값은 표시(true) — 명시적으로 끈 경우에만 false.
 */
export function getStoredBollingerVisible(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function setStoredBollingerVisible(visible: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, visible ? 'true' : 'false');
  } catch {
    // ignore storage write errors
  }
}

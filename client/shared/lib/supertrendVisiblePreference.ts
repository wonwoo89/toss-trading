const STORAGE_KEY = 'toss-trading:chart-supertrend-visible';

/**
 * 차트 슈퍼트렌드 표시 여부. 종목 전환(리마운트)에도 유지되도록 localStorage 에 영속.
 * 기본값은 미표시(false) — 사용자가 켤 때만 표시.
 */
export function getStoredSupertrendVisible(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setStoredSupertrendVisible(visible: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, visible ? 'true' : 'false');
  } catch {
    // ignore storage write errors
  }
}

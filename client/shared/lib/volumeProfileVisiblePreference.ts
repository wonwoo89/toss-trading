const STORAGE_KEY = 'toss-trading:chart-volume-profile-visible';

/**
 * 차트 매물대(볼륨 프로파일) 표시 여부. 종목 전환 시 리마운트돼도 유지되도록
 * localStorage 에 영속한다. 기본값은 표시(true) — 명시적으로 끈 경우에만 false.
 */
export function getStoredVolumeProfileVisible(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function setStoredVolumeProfileVisible(visible: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, visible ? 'true' : 'false');
  } catch {
    // ignore storage write errors
  }
}

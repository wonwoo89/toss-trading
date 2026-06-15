const STORAGE_KEY = 'toss-trading:realtime-polling-forced';

/**
 * 실시간 폴링 강제 토글. 기본은 OFF(=세션/주말 자동 게이팅 유지)이고, ON 이면 isClosed/세션
 * 판정을 무시하고 시세·캔들을 상시 폴링한다. 토스 캘린더 세션 데이터가 불안정할 때
 * (예: ET 기준 주말로 잡혀 데이/프리/애프터에도 폴링이 멈추는 경우) 사용자가 직접 켤 수 있다.
 */
export function getStoredRealtimePollingForced(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    // ignore storage read errors
    return false;
  }
}

export function setStoredRealtimePollingForced(forced: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, forced ? 'true' : 'false');
  } catch {
    // ignore storage write errors
  }
}

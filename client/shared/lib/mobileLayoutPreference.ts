const STORAGE_KEY = 'toss-trading:mobile-layout-v2';
const EVENT_NAME = 'toss-trading:mobile-layout-change';

/**
 * 모바일 신규 레이아웃(v2 — 하단 탭 구조) 사용 여부.
 * 기존(v1) 레이아웃과 토글로 전환하며 localStorage 에 영속한다.
 * Header 의 토글 버튼과 StockPage 가 서로 다른 트리에 있어 커스텀 이벤트로 동기화.
 */
export function getMobileLayoutV2(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setMobileLayoutV2(enabled: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
  } catch {
    // ignore storage write errors
  }
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: enabled }));
}

export function subscribeMobileLayout(callback: () => void): () => void {
  window.addEventListener(EVENT_NAME, callback);
  return () => window.removeEventListener(EVENT_NAME, callback);
}

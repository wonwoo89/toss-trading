const STORAGE_KEY = 'toss-trading:hidden-holdings';

/**
 * 자산에서 제외(숨김)할 보유 종목 심볼 목록. 토스 API 는 숨김 플래그를 주지 않으므로
 * WTS 가 자체적으로 관리한다(localStorage 영속). 심볼은 대문자로 정규화해 저장한다.
 * 숨긴 종목은 포트폴리오 합계·헤더 총자산에서 제외되며, 사이드바엔 "숨긴 종목" 접이식으로 표시된다.
 */
export function getStoredHiddenSymbols(): string[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    // ignore storage/parse errors
    return [];
  }
}

export function setStoredHiddenSymbols(symbols: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(symbols));
  } catch {
    // ignore storage write errors
  }
}

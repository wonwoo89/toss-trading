/** AI 브리핑 관심 종목(보유 외 추가 종목) — localStorage 영속. */

const KEY = 'toss-trading:briefing-extra-symbols';
const MAX_EXTRAS = 8;
const SYMBOL_RE = /^[A-Z][A-Z0-9.]{0,9}$/;

export function getBriefingExtras(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.toUpperCase())
      .filter((s) => SYMBOL_RE.test(s))
      .slice(0, MAX_EXTRAS);
  } catch {
    return [];
  }
}

export function setBriefingExtras(symbols: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(symbols.slice(0, MAX_EXTRAS)));
  } catch {
    // 저장 실패는 무시(세션 내 상태로만 동작)
  }
}

export function isValidBriefingSymbol(symbol: string): boolean {
  return SYMBOL_RE.test(symbol.toUpperCase());
}

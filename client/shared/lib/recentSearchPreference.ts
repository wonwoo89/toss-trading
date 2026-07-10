/**
 * 최근 검색 이력 (localStorage 영속 + 커스텀 이벤트로 컴포넌트 간 동기화).
 * 검색에서 종목을 선택할 때 기록하고, 검색 탭에서 칩으로 노출한다.
 */

export interface RecentSearchEntry {
  symbol: string;
  name?: string;
}

const KEY = 'toss-trading:recent-searches';
const EVENT = 'toss-trading:recent-search-change';
const MAX_ENTRIES = 10;

// useSyncExternalStore 의 getSnapshot 은 변경이 없으면 같은 참조를 돌려줘야 하므로
// 모듈 레벨 캐시를 유지한다(쓰기 시에만 새 배열로 교체 + 이벤트 발행).
let cache: RecentSearchEntry[] | null = null;

function load(): RecentSearchEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is RecentSearchEntry => typeof e?.symbol === 'string')
      .slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

export function getRecentSearches(): RecentSearchEntry[] {
  if (cache === null) cache = load();
  return cache;
}

function commit(next: RecentSearchEntry[]) {
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 저장 실패 무시(프라이빗 모드 등) — 세션 내 캐시로만 동작
  }
  window.dispatchEvent(new Event(EVENT));
}

/** 검색 선택 기록 — 같은 심볼은 맨 앞으로 이동, 최대 MAX_ENTRIES 유지. */
export function addRecentSearch(symbol: string, name?: string) {
  const upper = symbol.toUpperCase();
  const rest = getRecentSearches().filter((e) => e.symbol !== upper);
  commit([{ symbol: upper, name }, ...rest].slice(0, MAX_ENTRIES));
}

export function clearRecentSearches() {
  commit([]);
}

export function subscribeRecentSearches(callback: () => void) {
  window.addEventListener(EVENT, callback);
  return () => window.removeEventListener(EVENT, callback);
}

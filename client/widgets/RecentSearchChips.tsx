import { useSyncExternalStore } from 'react';
import { Chip } from '../shared/ui/Chip';
import { Button } from '../shared/ui/Button';
import { Typography } from '../shared/ui/Typography';
import {
  clearRecentSearches,
  getRecentSearches,
  subscribeRecentSearches,
} from '../shared/lib/recentSearchPreference';

interface RecentSearchChipsProps {
  /** 칩 탭 시 호출 — 호출부가 종목 이동 + 주문 탭 전환을 처리한다. */
  onSelect: (symbol: string) => void;
}

/** 검색 탭의 최근 검색 이력 — 칩으로 나열, 탭하면 해당 종목의 주문 화면으로 이동. */
export function RecentSearchChips({ onSelect }: RecentSearchChipsProps) {
  const entries = useSyncExternalStore(subscribeRecentSearches, getRecentSearches);

  if (entries.length === 0) return null;

  return (
    <div className="recent-searches" aria-label="최근 검색">
      <div className="recent-searches__head">
        <Typography size={12} className="recent-searches__title">최근 검색</Typography>
        <Button variant="ghost" size="sm" onClick={clearRecentSearches}>
          지우기
        </Button>
      </div>
      <div className="recent-searches__chips">
        {entries.map((entry) => (
          <Chip
            key={entry.symbol}
            title={entry.name}
            onClick={() => onSelect(entry.symbol)}
          >
            {entry.symbol}
            {entry.name && (
              <Typography size={12} truncate className="recent-searches__name">
                {entry.name}
              </Typography>
            )}
          </Chip>
        ))}
      </div>
    </div>
  );
}

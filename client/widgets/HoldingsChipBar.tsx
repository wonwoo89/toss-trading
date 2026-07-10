import { useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatSignedPercent, getKrProfitLossClass } from '../shared/lib/formatHoldings';
import { Typography } from '../shared/ui/Typography';
import type { HoldingItem } from '../shared/types';

interface HoldingsChipBarProps {
  holdings: HoldingItem[];
  activeSymbol?: string;
}

/**
 * 모바일 전용 보유 종목 칩 바. 티커 + 수익률(%)만 간략히 표시하고, 탭하면 해당 종목으로 이동한다.
 * 종목이 많으면 가로 스크롤. (사이드바까지 스크롤 내려가지 않고 상단에서 바로 종목 전환)
 *
 * 선택된 종목(activeSymbol)은 항상 맨 앞으로 재배치하고, 종목이 바뀌면 칩 바를 맨 앞으로
 * 스크롤한다. 재배치로 활성 칩이 항상 index 0 이므로 스크롤은 left:0 으로 단순화해
 * (특정 칩 위치 계산 없이) 스크롤 이동과 충돌하지 않게 한다.
 */
export function HoldingsChipBar({ holdings, activeSymbol }: HoldingsChipBarProps) {
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);

  // 선택 종목을 맨 앞으로 재배치(나머지는 기존 순서 유지). 폴링으로 holdings 가 갱신돼도
  // 활성 위치는 그대로라 시각적 재정렬이 일어나지 않는다.
  const orderedHoldings = useMemo(() => {
    if (!activeSymbol) return holdings;
    const index = holdings.findIndex(
      (item) => item.symbol.toUpperCase() === activeSymbol.toUpperCase()
    );
    if (index <= 0) return holdings;
    return [holdings[index], ...holdings.slice(0, index), ...holdings.slice(index + 1)];
  }, [holdings, activeSymbol]);

  // 종목이 바뀔 때만 맨 앞으로 스크롤(폴링 갱신엔 반응 안 함 → 스크롤 떨림 없음).
  useEffect(() => {
    containerRef.current?.scrollTo({ left: 0, behavior: 'smooth' });
  }, [activeSymbol]);

  if (holdings.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className="holdings-chip-bar"
      role="tablist"
      aria-label="보유 종목 빠른 전환"
    >
      {orderedHoldings.map((item) => {
        const isActive = item.symbol.toUpperCase() === activeSymbol?.toUpperCase();
        const pct = formatSignedPercent(item.profitLossRate, item.profitLoss);

        return (
          <button
            key={item.symbol}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={`holdings-chip${isActive ? ' is-active' : ''}`}
            onClick={() => navigate(`/stock/${item.symbol}`)}
          >
            <Typography size={12} className="holdings-chip__ticker">{item.symbol}</Typography>
            <Typography
              size={12}
              className={`holdings-chip__pl ${getKrProfitLossClass(item.profitLoss) ?? ''}`}
            >
              {pct ?? '—'}
            </Typography>
          </button>
        );
      })}
    </div>
  );
}

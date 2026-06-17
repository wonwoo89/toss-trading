import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatSignedPercent, getKrProfitLossClass } from '../shared/lib/formatHoldings';
import type { HoldingItem } from '../shared/types';

interface HoldingsChipBarProps {
  holdings: HoldingItem[];
  activeSymbol?: string;
}

/**
 * 모바일 전용 보유 종목 칩 바. 티커 + 수익률(%)만 간략히 표시하고, 탭하면 해당 종목으로 이동한다.
 * 종목이 많으면 가로 스크롤. (사이드바까지 스크롤 내려가지 않고 상단에서 바로 종목 전환)
 * 선택된 종목(activeSymbol)이 바뀌면 그 칩을 맨 앞(좌측)으로 스크롤해, 어떤 종목을 보고 있는지
 * 항상 첫 위치에서 바로 보이게 한다.
 */
export function HoldingsChipBar({ holdings, activeSymbol }: HoldingsChipBarProps) {
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const activeChipRef = useRef<HTMLButtonElement>(null);

  // 선택 종목이 바뀌면 활성 칩을 컨테이너 맨 앞(좌측 가장자리)으로 스크롤.
  useEffect(() => {
    const container = containerRef.current;
    const chip = activeChipRef.current;
    if (!container || !chip) return;

    const delta = chip.getBoundingClientRect().left - container.getBoundingClientRect().left;
    const paddingLeft = parseFloat(getComputedStyle(container).paddingLeft) || 0;
    container.scrollBy({ left: delta - paddingLeft, behavior: 'smooth' });
  }, [activeSymbol]);

  if (holdings.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className="holdings-chip-bar"
      role="tablist"
      aria-label="보유 종목 빠른 전환"
    >
      {holdings.map((item) => {
        const isActive = item.symbol.toUpperCase() === activeSymbol?.toUpperCase();
        const pct = formatSignedPercent(item.profitLossRate, item.profitLoss);

        return (
          <button
            key={item.symbol}
            ref={isActive ? activeChipRef : undefined}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={`holdings-chip${isActive ? ' is-active' : ''}`}
            onClick={() => navigate(`/stock/${item.symbol}`)}
          >
            <span className="holdings-chip__ticker">{item.symbol}</span>
            <span className={`holdings-chip__pl ${getKrProfitLossClass(item.profitLoss) ?? ''}`}>
              {pct ?? '—'}
            </span>
          </button>
        );
      })}
    </div>
  );
}

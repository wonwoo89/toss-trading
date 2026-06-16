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
 */
export function HoldingsChipBar({ holdings, activeSymbol }: HoldingsChipBarProps) {
  const navigate = useNavigate();

  if (holdings.length === 0) return null;

  return (
    <div className="holdings-chip-bar" role="tablist" aria-label="보유 종목 빠른 전환">
      {holdings.map((item) => {
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

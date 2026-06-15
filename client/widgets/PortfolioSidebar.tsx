import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { OpenOrdersPanel } from './OpenOrdersPanel';
import { PortfolioStats } from './PortfolioStats';
import { StockLabel } from './StockLabel';
import { formatProfitLoss, formatUsd, getKrProfitLossClass } from '../shared/lib/formatHoldings';
import type { HoldingItem, Order } from '../shared/types';

interface PortfolioSidebarProps {
  buyingPower?: number;
  totalMarketValue?: number;
  totalProfitLoss?: number;
  totalProfitLossRate?: number;
  holdings: HoldingItem[];
  hiddenHoldings?: HoldingItem[];
  onToggleHidden?: (symbol: string) => void;
  openOrders: Order[];
  activeSymbol?: string;
  holdingsPollIntervalMs?: number;
  holdingsRefreshing?: boolean;
  onCancelOrder: (orderId: string) => Promise<void>;
}

export function PortfolioSidebar({
  buyingPower,
  totalMarketValue,
  totalProfitLoss,
  totalProfitLossRate,
  holdings,
  hiddenHoldings = [],
  onToggleHidden,
  openOrders,
  activeSymbol,
  holdingsPollIntervalMs = 5000,
  holdingsRefreshing,
  onCancelOrder,
}: PortfolioSidebarProps) {
  const navigate = useNavigate();
  const [showHidden, setShowHidden] = useState(false);

  // 보유 종목 가치/PL 실시간 flash (UI/UX)
  const prevValuesRef = useRef<Record<string, number>>({});
  const [flashes, setFlashes] = useState<Record<string, 'up' | 'down'>>({});

  useEffect(() => {
    const nextFlashes: Record<string, 'up' | 'down'> = {};
    holdings.forEach((item) => {
      const prev = prevValuesRef.current[item.symbol];
      const curr = item.marketValue ?? 0;
      if (prev != null && curr !== prev) {
        nextFlashes[item.symbol] = curr > prev ? 'up' : 'down';
      }
      prevValuesRef.current[item.symbol] = curr;
    });

    if (Object.keys(nextFlashes).length > 0) {
      setFlashes(nextFlashes);
      const t = setTimeout(() => setFlashes({}), 700);
      return () => clearTimeout(t);
    }
  }, [holdings]);

  const goToStock = (symbol: string) => {
    navigate(`/stock/${symbol}`);
  };

  return (
    <aside className="portfolio-sidebar">
      <section className="panel portfolio-sidebar__summary">
        <PortfolioStats
          buyingPower={buyingPower}
          totalMarketValue={totalMarketValue}
          totalProfitLoss={totalProfitLoss}
          totalProfitLossRate={totalProfitLossRate}
        />
      </section>

      <section className="panel portfolio-sidebar__holdings">
        <div className="panel-title">
          <h2>보유 종목</h2>
          <span className="price-meta">
            <span
              className={`refresh-dot${holdingsRefreshing ? ' is-active' : ''}`}
              aria-hidden={!holdingsRefreshing}
            />
            {holdingsPollIntervalMs / 1000}초마다 갱신
          </span>
        </div>

        <div className="panel-body portfolio-holdings-list">
          {holdings.length === 0 ? (
            <p className="hint">보유한 미국 주식이 없습니다.</p>
          ) : (
            <ul className="portfolio-holdings-list__items">
              {holdings.map((item) => {
                const isActive = item.symbol.toUpperCase() === activeSymbol?.toUpperCase();

                return (
                  <li key={item.symbol} className="portfolio-holding-row">
                    <button
                      type="button"
                      className={`portfolio-holding-item${isActive ? ' is-active' : ''}`}
                      onClick={() => goToStock(item.symbol)}
                    >
                      <div className="portfolio-holding-item__main">
                        <StockLabel symbol={item.symbol} />
                        <span
                          className={`portfolio-holding-item__value ${flashes[item.symbol] ? `price-flash-${flashes[item.symbol]}` : ''}`}
                        >
                          {formatUsd(item.marketValue)}
                        </span>
                      </div>
                      <div className="portfolio-holding-item__meta">
                        <span className="portfolio-holding-item__qty">
                          {item.quantity.toLocaleString('en-US', {
                            maximumFractionDigits: 4,
                          })}
                          주
                        </span>
                        <span
                          className={`portfolio-holding-item__pl ${getKrProfitLossClass(item.profitLoss) ?? ''}`}
                        >
                          {formatProfitLoss(item.profitLoss, item.profitLossRate)}
                        </span>
                      </div>
                    </button>
                    {onToggleHidden && (
                      <button
                        type="button"
                        className="portfolio-holding-hide"
                        title="자산에서 숨기기"
                        aria-label={`${item.symbol} 자산에서 숨기기`}
                        onClick={() => onToggleHidden(item.symbol)}
                      >
                        숨기기
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {hiddenHoldings.length > 0 && (
            <div className="portfolio-hidden">
              <button
                type="button"
                className="portfolio-hidden__toggle"
                onClick={() => setShowHidden((prev) => !prev)}
                aria-expanded={showHidden}
              >
                <span>숨긴 종목 {hiddenHoldings.length}개</span>
                <span className="portfolio-hidden__chevron">{showHidden ? '▾' : '▸'}</span>
              </button>

              {showHidden && (
                <ul className="portfolio-holdings-list__items portfolio-hidden__items">
                  {hiddenHoldings.map((item) => {
                    const isActive = item.symbol.toUpperCase() === activeSymbol?.toUpperCase();

                    return (
                      <li key={item.symbol} className="portfolio-holding-row">
                        <button
                          type="button"
                          className={`portfolio-holding-item is-hidden${isActive ? ' is-active' : ''}`}
                          onClick={() => goToStock(item.symbol)}
                        >
                          <div className="portfolio-holding-item__main">
                            <StockLabel symbol={item.symbol} />
                            <span className="portfolio-holding-item__value">
                              {formatUsd(item.marketValue)}
                            </span>
                          </div>
                          <div className="portfolio-holding-item__meta">
                            <span className="portfolio-holding-item__qty">
                              {item.quantity.toLocaleString('en-US', {
                                maximumFractionDigits: 4,
                              })}
                              주
                            </span>
                            <span
                              className={`portfolio-holding-item__pl ${getKrProfitLossClass(item.profitLoss) ?? ''}`}
                            >
                              {formatProfitLoss(item.profitLoss, item.profitLossRate)}
                            </span>
                          </div>
                        </button>
                        {onToggleHidden && (
                          <button
                            type="button"
                            className="portfolio-holding-hide"
                            title="자산에 다시 표시"
                            aria-label={`${item.symbol} 자산에 다시 표시`}
                            onClick={() => onToggleHidden(item.symbol)}
                          >
                            표시
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      </section>

      <OpenOrdersPanel openOrders={openOrders} onCancel={onCancelOrder} />
    </aside>
  );
}

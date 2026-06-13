import { useNavigate } from 'react-router-dom';
import { OpenOrdersPanel } from './OpenOrdersPanel';
import { PortfolioStats } from './PortfolioStats';
import { StockLabel } from './StockLabel';
import { formatProfitLoss, formatUsd, getKrProfitLossClass } from "../shared/lib/formatHoldings';
import type { HoldingItem, Order } from '../types';

interface PortfolioSidebarProps {
  buyingPower?: number;
  totalMarketValue?: number;
  totalProfitLoss?: number;
  totalProfitLossRate?: number;
  holdings: HoldingItem[];
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
  openOrders,
  activeSymbol,
  holdingsPollIntervalMs = 5000,
  holdingsRefreshing,
  onCancelOrder,
}: PortfolioSidebarProps) {
  const navigate = useNavigate();

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
                  <li key={item.symbol}>
                    <button
                      type="button"
                      className={`portfolio-holding-item${isActive ? ' is-active' : ''}`}
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
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      <OpenOrdersPanel openOrders={openOrders} onCancel={onCancelOrder} />
    </aside>
  );
}

import { useNavigate } from 'react-router-dom';
import { StockLabel } from './StockLabel';
import {
  formatProfitLoss,
  formatQuantity,
  formatUsd,
  getKrProfitLossClass,
} from "../shared/lib/formatHoldings';
import type { HoldingItem } from '../types';

interface HoldingsPanelProps {
  holdings: HoldingItem[];
  pollIntervalMs?: number;
  refreshing?: boolean;
}

export function HoldingsPanel({ holdings, pollIntervalMs = 5000, refreshing }: HoldingsPanelProps) {
  const navigate = useNavigate();

  const goToStock = (symbol: string) => {
    navigate(`/stock/${symbol}`);
  };

  return (
    <section className="panel holdings-panel">
      <div className="panel-title">
        <h2>보유 종목</h2>
        <span className="price-meta">
          <span
            className={`refresh-dot${refreshing ? ' is-active' : ''}`}
            aria-hidden={!refreshing}
          />
          {pollIntervalMs / 1000}초마다 갱신
        </span>
      </div>

      <div className="panel-body">
        {holdings.length === 0 ? (
          <p className="hint">
            보유한 미국 주식이 없습니다. 위에서 종목을 검색해 거래 화면으로 이동할 수 있습니다.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>종목</th>
                <th>현재가</th>
                <th>평균단가</th>
                <th>수량</th>
                <th>평가금액</th>
              </tr>
            </thead>
            <tbody>
              {holdings.map((item) => (
                <tr
                  key={item.symbol}
                  className="clickable-row"
                  role="button"
                  tabIndex={0}
                  onClick={() => goToStock(item.symbol)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      goToStock(item.symbol);
                    }
                  }}
                >
                  <td>
                    <StockLabel symbol={item.symbol} />
                  </td>
                  <td>{formatUsd(item.currentPrice)}</td>
                  <td>{formatUsd(item.averagePrice)}</td>
                  <td>{formatQuantity(item.quantity)}</td>
                  <td>
                    <div className="holding-value">
                      <span>{formatUsd(item.marketValue)}</span>
                      <span className={`holding-pl ${getKrProfitLossClass(item.profitLoss) ?? ''}`}>
                        {formatProfitLoss(item.profitLoss, item.profitLossRate)}
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

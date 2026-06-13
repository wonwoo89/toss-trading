import { useMemo, useState } from 'react';
import { CandleChart } from './CandleChart';
import { ChartMarketContextPanel } from './ChartMarketContextPanel';
import { ChartSignalPanel } from './ChartSignalPanel';
import { StockLabel } from './StockLabel';
import {
  buildSpreadSnapshot,
  buildTradeFlowSnapshot,
  type MicrostructureBias,
} from "../shared/lib/marketMicrostructure';
import {
  CANDLE_INTERVALS,
  type CandleInterval,
  type ChartCandle,
  type CommissionRaw,
  type HoldingItem,
  type Order,
  type UsMarketDayRaw,
} from '../types';

interface OrderbookEntry {
  price: number;
  quantity: number;
}

interface MarketPanelProps {
  symbol: string;
  stockName?: string;
  bids?: OrderbookEntry[];
  asks?: OrderbookEntry[];
  trades?: { price: number; quantity: number; timestamp: string }[];
  candles?: ChartCandle[];
  averagePrice?: number;
  candleInterval: CandleInterval;
  onCandleIntervalChange: (interval: CandleInterval) => void;
  candlesLoading?: boolean;
  candlesLoadingOlder?: boolean;
  candlesError?: string | null;
  hasMoreHistory?: boolean;
  onLoadOlderCandles?: () => void;
  warnings?: string[];
  currentPrice?: number;
  holding?: HoldingItem;
  holdingProfitLossRate?: number;
  targetProfitRatePercent?: number;
  usMarketDay?: UsMarketDayRaw;
  usMarketCalendarError?: string | null;
  usMarketCalendarLoading?: boolean;
  openOrders?: Order[];
  closedOrders?: Order[];
  closedOrdersUnavailable?: boolean;
  buyingPower?: number;
  sellableQuantity?: number;
  commissions?: CommissionRaw[];
}

function formatUsd(value?: number) {
  if (value === undefined) return '—';
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

function getMetricBiasClass(bias: MicrostructureBias) {
  if (bias === 'bullish') return 'orderbook-summary__metric--bullish';
  if (bias === 'bearish') return 'orderbook-summary__metric--bearish';
  return 'orderbook-summary__metric--neutral';
}

export function MarketPanel({
  symbol,
  stockName,
  bids = [],
  asks = [],
  trades = [],
  candles = [],
  averagePrice,
  candleInterval,
  onCandleIntervalChange,
  candlesLoading,
  candlesLoadingOlder,
  candlesError,
  hasMoreHistory,
  onLoadOlderCandles,
  warnings = [],
  currentPrice,
  holding,
  holdingProfitLossRate,
  targetProfitRatePercent = 3,
  usMarketDay,
  usMarketCalendarError,
  usMarketCalendarLoading,
  openOrders = [],
  closedOrders = [],
  closedOrdersUnavailable = false,
  buyingPower,
  sellableQuantity,
  commissions = [],
}: MarketPanelProps) {
  const [orderbookExpanded, setOrderbookExpanded] = useState(false);

  const spread = useMemo(() => buildSpreadSnapshot(bids, asks), [asks, bids]);
  const tradeFlow = useMemo(() => buildTradeFlowSnapshot(trades, bids, asks), [asks, bids, trades]);

  return (
    <section className="panel market-panel">
      {warnings.length > 0 && (
        <div className="warning-box">
          {warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      )}

      <div className="chart-panel">
        <div className="chart-toolbar">
          <StockLabel symbol={symbol} name={stockName} as="heading" />
          <div className="order-quick-actions chart-interval">
            {CANDLE_INTERVALS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={candleInterval === option.value ? 'active' : ''}
                onClick={() => onCandleIntervalChange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <ChartSignalPanel
          candles={candles}
          bids={bids}
          asks={asks}
          warnings={warnings}
          loading={candlesLoading}
        />

        <ChartMarketContextPanel
          marketDay={usMarketDay}
          calendarError={usMarketCalendarError}
          calendarLoading={usMarketCalendarLoading}
          bids={bids}
          asks={asks}
          trades={trades}
          candles={candles}
          candleInterval={candleInterval}
          currentPrice={currentPrice}
          holding={holding}
          profitLossRate={holdingProfitLossRate}
          targetProfitRatePercent={targetProfitRatePercent}
          openOrders={openOrders}
          closedOrders={closedOrders}
          closedOrdersUnavailable={closedOrdersUnavailable}
          buyingPower={buyingPower}
          sellableQuantity={sellableQuantity}
          commissions={commissions}
          warnings={warnings}
        />

        <CandleChart
          candles={candles}
          averagePrice={averagePrice}
          loading={candlesLoading}
          loadingOlder={candlesLoadingOlder}
          error={candlesError}
          fitKey={`${symbol}:${candleInterval}`}
          hasMoreHistory={hasMoreHistory}
          onLoadOlder={onLoadOlderCandles}
        />
      </div>

      <div
        className={`market-panel__orderbook${orderbookExpanded ? ' market-panel__orderbook--expanded' : ''}`}
      >
        <div className="orderbook-summary">
          <div className="orderbook-summary__metrics" aria-live="polite">
            <span className="orderbook-summary__metric orderbook-summary__metric--bearish">
              <span className="orderbook-summary__metric-label">매도 1호가</span>
              <span className="orderbook-summary__metric-value">{formatUsd(spread.bestAsk)}</span>
            </span>
            <span className="orderbook-summary__metric orderbook-summary__metric--bullish">
              <span className="orderbook-summary__metric-label">매수 1호가</span>
              <span className="orderbook-summary__metric-value">{formatUsd(spread.bestBid)}</span>
            </span>
            <span className={`orderbook-summary__metric ${getMetricBiasClass(spread.bias)}`}>
              <span className="orderbook-summary__metric-label">{spread.label}</span>
              <span className="orderbook-summary__metric-value">{spread.value}</span>
            </span>
            <span className={`orderbook-summary__metric ${getMetricBiasClass(tradeFlow.bias)}`}>
              <span className="orderbook-summary__metric-label">{tradeFlow.label}</span>
              <span className="orderbook-summary__metric-value">{tradeFlow.value}</span>
            </span>
          </div>
          <button
            type="button"
            className="orderbook-summary__toggle"
            aria-expanded={orderbookExpanded}
            onClick={() => setOrderbookExpanded((expanded) => !expanded)}
          >
            {orderbookExpanded ? '접기' : '호가 상세'}
          </button>
        </div>

        {orderbookExpanded && (
          <div className="market-grid orderbook-detail">
            <div>
              <h3>매도호가</h3>
              <table>
                <thead>
                  <tr>
                    <th>가격</th>
                    <th>수량</th>
                  </tr>
                </thead>
                <tbody>
                  {asks.length === 0 ? (
                    <tr>
                      <td colSpan={2}>호가 없음</td>
                    </tr>
                  ) : (
                    asks.slice(0, 8).map((ask, index) => (
                      <tr key={`ask-${index}`}>
                        <td className="down">{formatUsd(ask.price)}</td>
                        <td>{ask.quantity}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div>
              <h3>매수호가</h3>
              <table>
                <thead>
                  <tr>
                    <th>가격</th>
                    <th>수량</th>
                  </tr>
                </thead>
                <tbody>
                  {bids.length === 0 ? (
                    <tr>
                      <td colSpan={2}>호가 없음</td>
                    </tr>
                  ) : (
                    bids.slice(0, 8).map((bid, index) => (
                      <tr key={`bid-${index}`}>
                        <td className="up">{formatUsd(bid.price)}</td>
                        <td>{bid.quantity}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div>
              <h3>체결</h3>
              <table>
                <thead>
                  <tr>
                    <th>시간</th>
                    <th>가격</th>
                    <th>수량</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.length === 0 ? (
                    <tr>
                      <td colSpan={3}>체결 없음</td>
                    </tr>
                  ) : (
                    trades.slice(0, 10).map((trade, index) => (
                      <tr key={`trade-${index}`}>
                        <td>{new Date(trade.timestamp).toLocaleTimeString('ko-KR')}</td>
                        <td>{formatUsd(trade.price)}</td>
                        <td>{trade.quantity}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

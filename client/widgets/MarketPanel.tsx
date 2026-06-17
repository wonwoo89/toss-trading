import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
// lightweight-charts(차트 청크)를 지연 로드 → 주문폼/시세가 먼저 그려진다.
const CandleChart = lazy(() =>
  import('./CandleChart').then((m) => ({ default: m.CandleChart }))
);
import { ChartMarketContextPanel } from './ChartMarketContextPanel';
import { ChartSignalPanel } from './ChartSignalPanel';
import { StockLabel } from './StockLabel';
import { BacktestModal } from './BacktestModal';
import {
  buildSpreadSnapshot,
  buildTradeFlowSnapshot,
  type MicrostructureBias,
} from '../shared/lib/marketMicrostructure';
import {
  getStoredDetailsExpanded,
  setStoredDetailsExpanded,
} from '../shared/lib/detailsExpandedPreference';
import {
  getStoredBollingerVisible,
  setStoredBollingerVisible,
} from '../shared/lib/bollingerVisiblePreference';
import {
  CANDLE_INTERVALS,
  type CandleInterval,
  type ChartCandle,
  type CommissionRaw,
  type HoldingItem,
  type Order,
  type UsMarketCalendarRaw,
} from '../shared/types';

interface OrderbookEntry {
  price: number;
  quantity: number;
}

interface MarketPanelProps {
  symbol: string;
  stockName?: string;
  previousClose?: number;
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
  usMarketCalendar?: UsMarketCalendarRaw | null;
  usMarketCalendarError?: string | null;
  usMarketCalendarLoading?: boolean;
  openOrders?: Order[];
  buyingPower?: number;
  sellableQuantity?: number;
  commissions?: CommissionRaw[];
  realtimePollingForced?: boolean;
  onRealtimePollingForcedChange?: (forced: boolean) => void;
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
  previousClose,
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
  usMarketCalendar,
  usMarketCalendarError,
  usMarketCalendarLoading,
  openOrders = [],
  buyingPower,
  sellableQuantity,
  commissions = [],
  realtimePollingForced = false,
  onRealtimePollingForcedChange,
}: MarketPanelProps) {
  const [orderbookExpanded, setOrderbookExpanded] = useState(false);
  const [backtestOpen, setBacktestOpen] = useState(false);
  const [bollingerVisible, setBollingerVisible] = useState(getStoredBollingerVisible);

  const handleBollingerVisibleChange = (visible: boolean) => {
    setBollingerVisible(visible);
    setStoredBollingerVisible(visible);
  };

  // 데스크톱(>1100px)은 항상 펼침. 모바일은 사용자가 토글한 펼침/접힘 상태를 localStorage 에
  // 영속해, 종목이 바뀌어 MarketPanel 이 리마운트돼도 유지한다.
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== 'undefined' && window.innerWidth > 1100
  );
  const [mobileDetailsExpanded, setMobileDetailsExpanded] = useState(getStoredDetailsExpanded);

  useEffect(() => {
    const update = () => setIsDesktop(window.innerWidth > 1100);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  const detailsExpanded = isDesktop ? true : mobileDetailsExpanded;

  const toggleDetails = () => {
    setMobileDetailsExpanded((prev) => {
      const next = !prev;
      setStoredDetailsExpanded(next);
      return next;
    });
  };

  const spread = useMemo(() => buildSpreadSnapshot(bids, asks), [asks, bids]);

  // 가격 변동 flash (UI/UX) — best bid/ask 실시간 변화 하이라이트
  const [prevBestBid, setPrevBestBid] = useState<number | undefined>();
  const [prevBestAsk, setPrevBestAsk] = useState<number | undefined>();
  const [bidFlash, setBidFlash] = useState<'up' | 'down' | null>(null);
  const [askFlash, setAskFlash] = useState<'up' | 'down' | null>(null);

  const bestBid = spread.bestBid;
  const bestAsk = spread.bestAsk;

  useEffect(() => {
    if (bestBid != null && prevBestBid != null && bestBid !== prevBestBid) {
      setBidFlash(bestBid > prevBestBid ? 'up' : 'down');
      const t = setTimeout(() => setBidFlash(null), 700);
      return () => clearTimeout(t);
    }
    if (bestBid != null) setPrevBestBid(bestBid);
  }, [bestBid]);

  useEffect(() => {
    if (bestAsk != null && prevBestAsk != null && bestAsk !== prevBestAsk) {
      setAskFlash(bestAsk > prevBestAsk ? 'up' : 'down');
      const t = setTimeout(() => setAskFlash(null), 700);
      return () => clearTimeout(t);
    }
    if (bestAsk != null) setPrevBestAsk(bestAsk);
  }, [bestAsk]);
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
          <div className="chart-toolbar__controls">
            {onRealtimePollingForcedChange && (
              <label
                className="realtime-toggle"
                title="켜면 장 세션(프리/데이/애프터/정규)·주말과 무관하게 시세·차트를 계속 갱신합니다."
              >
                <input
                  type="checkbox"
                  checked={realtimePollingForced}
                  onChange={(e) => onRealtimePollingForcedChange(e.target.checked)}
                />
                <span>실시간</span>
              </label>
            )}
            <label className="bollinger-toggle" title="볼린저밴드 표시 켜기/끄기">
              <input
                type="checkbox"
                checked={bollingerVisible}
                onChange={(e) => handleBollingerVisibleChange(e.target.checked)}
              />
              <span>볼린저</span>
            </label>
            <select
              className="chart-interval"
              value={candleInterval}
              onChange={(e) => onCandleIntervalChange(e.target.value as CandleInterval)}
            >
              {CANDLE_INTERVALS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="chart-backtest-btn"
              onClick={() => setBacktestOpen(true)}
              title="이 종목 신호 백테스트"
            >
              백테스트
            </button>
          </div>
        </div>

        <div className="chart-bleed">
          <Suspense
            fallback={
              <div className="chart-block chart-block--loading">
                <p className="chart-status hint">차트 불러오는 중…</p>
              </div>
            }
          >
            <CandleChart
              candles={candles}
              averagePrice={averagePrice}
              loading={candlesLoading}
              loadingOlder={candlesLoadingOlder}
              error={candlesError}
              fitKey={`${symbol}:${candleInterval}`}
              hasMoreHistory={hasMoreHistory}
              onLoadOlder={onLoadOlderCandles}
              showBollinger={bollingerVisible}
            />
          </Suspense>
        </div>
      </div>

      {/* Indicators below the chart */}
      <div className="market-indicators">
        <ChartSignalPanel
          candles={candles}
          bids={bids}
          asks={asks}
          warnings={warnings}
          loading={candlesLoading}
          showMetrics={detailsExpanded}
          detailsExpanded={detailsExpanded}
          onToggleDetails={toggleDetails}
        />

        <div className={`market-divider chart-signal-divider ${detailsExpanded ? 'is-visible' : ''}`} />

        <div className={`market-details-content ${detailsExpanded ? 'is-expanded' : ''}`}>
          <ChartMarketContextPanel
            marketCalendar={usMarketCalendar}
            calendarError={usMarketCalendarError}
            calendarLoading={usMarketCalendarLoading}
            candles={candles}
            candleInterval={candleInterval}
            currentPrice={currentPrice}
            previousClose={previousClose}
            holding={holding}
            profitLossRate={holdingProfitLossRate}
            targetProfitRatePercent={targetProfitRatePercent}
            openOrders={openOrders}
            buyingPower={buyingPower}
            sellableQuantity={sellableQuantity}
            commissions={commissions}
            warnings={warnings}
          />
        </div>
      </div>

      {/* Divider separating indicators from orderbook */}
      <div className="market-divider" />

      <div
        className={`market-panel__orderbook${orderbookExpanded ? ' market-panel__orderbook--expanded' : ''}`}
      >
        <div className="orderbook-summary">
          <div className="orderbook-summary__metrics" aria-live="polite">
            <span className="orderbook-summary__metric orderbook-summary__metric--bearish">
              <span className="orderbook-summary__metric-label">매도 1호가</span>
              <span
                className={`orderbook-summary__metric-value ${askFlash ? `price-flash-${askFlash}` : ''}`}
              >
                {formatUsd(spread.bestAsk)}
              </span>
            </span>
            <span className="orderbook-summary__metric orderbook-summary__metric--bullish">
              <span className="orderbook-summary__metric-label">매수 1호가</span>
              <span
                className={`orderbook-summary__metric-value ${bidFlash ? `price-flash-${bidFlash}` : ''}`}
              >
                {formatUsd(spread.bestBid)}
              </span>
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

      {backtestOpen && (
        <BacktestModal symbol={symbol} onClose={() => setBacktestOpen(false)} />
      )}
    </section>
  );
}

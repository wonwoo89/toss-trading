import { lazy, Suspense, useEffect, useState } from 'react';
// lightweight-charts(차트 청크)를 지연 로드 → 주문폼/시세가 먼저 그려진다.
const CandleChart = lazy(() =>
  import('./CandleChart').then((m) => ({ default: m.CandleChart }))
);
import { ChartMarketContextPanel } from './ChartMarketContextPanel';
import { ChartSignalPanel } from './ChartSignalPanel';
import { OrderbookPanel } from './OrderbookPanel';
import { StockLabel } from './StockLabel';
import { BacktestModal } from './BacktestModal';
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
  currency?: string;
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
  currency = 'USD',
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
              currency={currency}
            />
          </Suspense>
        </div>
      </div>

      {/* 차트 아래: 좌(지표·시장정보) / 우(호가) 좌우 배치 */}
      <div className="market-panel__below">
        <div className="market-panel__below-info">
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
        </div>

        <div className="market-panel__side">
          <OrderbookPanel
            bids={bids}
            asks={asks}
            trades={trades}
            currency={currency}
            expanded={isDesktop || orderbookExpanded}
            showToggle={!isDesktop}
            onToggle={() => setOrderbookExpanded((v) => !v)}
          />
        </div>
      </div>

      {backtestOpen && (
        <BacktestModal symbol={symbol} onClose={() => setBacktestOpen(false)} />
      )}
    </section>
  );
}

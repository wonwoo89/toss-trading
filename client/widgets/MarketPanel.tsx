import { lazy, Suspense, useEffect, useState } from 'react';
// lightweight-charts(차트 청크)를 지연 로드 → 주문폼/시세가 먼저 그려진다.
const CandleChart = lazy(() =>
  import('./CandleChart').then((m) => ({ default: m.CandleChart }))
);
import { ChartMarketContextPanel } from './ChartMarketContextPanel';
import { ChartOptionsMenu } from './ChartOptionsMenu';
import { AutoTradePanel } from './AutoTradePanel';
import { Button } from '../shared/ui/Button';
import { StockLabel } from './StockLabel';
import { BacktestModal } from './BacktestModal';
import {
  getStoredBollingerVisible,
  setStoredBollingerVisible,
} from '../shared/lib/bollingerVisiblePreference';
import {
  getStoredSupertrendVisible,
  setStoredSupertrendVisible,
} from '../shared/lib/supertrendVisiblePreference';
import {
  getStoredVolumeProfileBins,
  getStoredVolumeProfileVisible,
  setStoredVolumeProfileBins,
  setStoredVolumeProfileVisible,
} from '../shared/lib/volumeProfileVisiblePreference';
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
  /** 자동매매 주문 실행(StockPage 가 createOrder 로 직결). orderAmount=금액 시장가 소수점 매수. */
  onAutoExecute?: (
    side: 'BUY' | 'SELL',
    quantity: number,
    limitPrice?: number,
    orderAmount?: number
  ) => void;
  /** 자동매매 미체결 취소(가격 이탈 시) — StockPage 의 cancelOrder 직결. */
  onAutoCancelOrder?: (orderId: string) => Promise<void> | void;
  /** 자동매매 주문 제출 중 여부. */
  autoSubmitting?: boolean;
  /** 세미오토/오토 활성 여부 변경 알림 — 주문폼의 수동 주문 잠금에 사용. */
  onAutoExecModeChange?: (active: boolean) => void;
}

export function MarketPanel({
  symbol,
  stockName,
  previousClose,
  bids = [],
  asks = [],
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
  onAutoExecute,
  onAutoCancelOrder,
  autoSubmitting = false,
  onAutoExecModeChange,
}: MarketPanelProps) {
  const [backtestOpen, setBacktestOpen] = useState(false);
  const [bollingerVisible, setBollingerVisible] = useState(getStoredBollingerVisible);

  const handleBollingerVisibleChange = (visible: boolean) => {
    setBollingerVisible(visible);
    setStoredBollingerVisible(visible);
  };

  const [supertrendVisible, setSupertrendVisible] = useState(getStoredSupertrendVisible);
  const handleSupertrendVisibleChange = (visible: boolean) => {
    setSupertrendVisible(visible);
    setStoredSupertrendVisible(visible);
  };

  const [volumeProfileVisible, setVolumeProfileVisible] = useState(getStoredVolumeProfileVisible);
  const handleVolumeProfileVisibleChange = (visible: boolean) => {
    setVolumeProfileVisible(visible);
    setStoredVolumeProfileVisible(visible);
  };

  const [volumeProfileBins, setVolumeProfileBins] = useState(getStoredVolumeProfileBins);
  const handleVolumeProfileBinsChange = (bins: number) => {
    setVolumeProfileBins(bins);
    setStoredVolumeProfileBins(bins);
  };

  // isDesktop 은 호가 항상 펼침 판정 + 자동매매 모바일 안내 노출에 사용.
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== 'undefined' && window.innerWidth > 1100
  );

  useEffect(() => {
    const update = () => setIsDesktop(window.innerWidth > 1100);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  // 자동매매(AI) 매수 수량 상한 계산용 — 현재가 기준 최대 매수 가능 수량.
  const maxBuyQuantity =
    buyingPower !== undefined && buyingPower > 0 && currentPrice !== undefined && currentPrice > 0
      ? Math.floor(buyingPower / currentPrice)
      : undefined;

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
            <ChartOptionsMenu
              realtimeForced={realtimePollingForced}
              onRealtimeForcedChange={onRealtimePollingForcedChange}
              bollingerVisible={bollingerVisible}
              onBollingerVisibleChange={handleBollingerVisibleChange}
              supertrendVisible={supertrendVisible}
              onSupertrendVisibleChange={handleSupertrendVisibleChange}
              volumeProfileVisible={volumeProfileVisible}
              onVolumeProfileVisibleChange={handleVolumeProfileVisibleChange}
              volumeProfileBins={volumeProfileBins}
              onVolumeProfileBinsChange={handleVolumeProfileBinsChange}
            />
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
            <Button
              size="sm"
              variant="ghost"
              className="chart-backtest-btn"
              onClick={() => setBacktestOpen(true)}
              title="이 종목 신호 백테스트"
            >
              백테스트
            </Button>
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
              candleInterval={candleInterval}
              hasMoreHistory={hasMoreHistory}
              onLoadOlder={onLoadOlderCandles}
              showBollinger={bollingerVisible}
              showSupertrend={supertrendVisible}
              showVolumeProfile={volumeProfileVisible}
              volumeProfileBins={volumeProfileBins}
              currency={currency}
            />
          </Suspense>
        </div>
      </div>

      {/* 차트 아래: 자동매매 + 지표·시장정보 (호가는 주문 컬럼의 별도 섹션으로 이동) */}
      <div className="market-panel__below">
        <div className="market-panel__below-info">
      {/* 자동매매 — 차트 페이지에 상주. 탭을 오가도(종목이 같으면) 마운트가 유지돼 상태 보존.
          주문 실행은 StockPage 의 createOrder 직결 경로(onAutoExecute)를 사용. */}
      {currency === 'USD' && onAutoExecute && (
        <div className="market-auto-trade">
          <AutoTradePanel
            symbol={symbol}
            currentPrice={currentPrice}
            holding={holding}
            sellableQuantity={sellableQuantity}
            takeProfitRatePercent={targetProfitRatePercent}
            buyingPower={buyingPower}
            submitting={autoSubmitting}
            onAutoExecute={onAutoExecute}
            onExecModeChange={onAutoExecModeChange}
            isMobile={!isDesktop}
            candles={candles}
            candleInterval={candleInterval}
            bids={bids}
            asks={asks}
            previousClose={previousClose}
            maxBuyQuantity={maxBuyQuantity}
            openOrders={openOrders}
            currency={currency}
            usMarketCalendar={usMarketCalendar}
            commissions={commissions}
            onCancelOrder={onAutoCancelOrder}
          />
        </div>
      )}

      {/* Indicators below the chart — 상세정보는 항상 펼침(접기 기능 제거) */}
      <div className="market-indicators">
        <div className="market-details-content is-expanded">
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
            commissions={commissions}
            warnings={warnings}
          />
        </div>
      </div>
        </div>
      </div>

      {backtestOpen && (
        <BacktestModal symbol={symbol} onClose={() => setBacktestOpen(false)} />
      )}
    </section>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../shared/api/client';
import { MarketPanel } from "../widgets/MarketPanel';
import { OrderForm } from "../widgets/OrderForm';
import { PortfolioSidebar } from "../widgets/PortfolioSidebar';

import { useAppContext, useRequireAccountSeq } from '../../app/providers/AppContext';
import { useChartCandles } from '../../shared/hooks/useChartCandles';
import { usePolling } from '../../shared/hooks/usePolling';
import {
  MARKET_POLL_MS,
  MARKET_CALENDAR_POLL_MS,
  COMMISSIONS_POLL_MS,
  CLOSED_ORDERS_POLL_MS,
  CANDLE_POLL_MS,
  TRADE_POLL_MS,
  HOLDINGS_POLL_MS,
  MARKET_INITIAL_DELAY_MS,
  CANDLE_INITIAL_DELAY_MS,
  TRADE_INITIAL_DELAY_MS,
  PORTFOLIO_INITIAL_DELAY_MS,
  getCachedHoldings,
  getCachedOpenOrders,
  useSymbolTrading,
} from '../../shared/hooks/useSymbolTrading';
import { shouldEnableRecurringMarketPolling } from '../../shared/lib/usMarketCalendar';
import { getStoredCandleInterval, setStoredCandleInterval } from '../../shared/lib/candleIntervalPreference';
import { getStoredTakeProfitRate, setStoredTakeProfitRate } from '../../shared/lib/takeProfitRatePreference';

import { setLastSelectedSymbol } from '../../shared/lib/lastSymbolPreference';
import { mapHoldings, mapOrders, resolveLiveProfitLoss } from '../../shared/lib/mapPortfolio';
import {
  setPortfolioHoldings as savePortfolioHoldings,
  setPortfolioOpenOrders as savePortfolioOpenOrders,
  upsertPortfolioHolding,
} from '../../shared/lib/portfolioCache';
import {
  getOpenOrdersSignature,
  refreshOpenOrdersAfterCancel,
  refreshOpenOrdersAfterCreate,
} from '../../shared/lib/refreshOpenOrders';
import {
  fetchTradeSnapshotState,
  fetchTradeSnapshotWithRetry,
  type TradeSnapshotState,
} from '../../shared/lib/tradeSnapshot';
import { resolveUsCommissionRatePercent } from '../../shared/lib/commissionBreakEven';
import {
  calculateTakeProfitSellPrice,
  getTakeProfitCostContext,
  resolveTakeProfitSellQuantity,
  waitForTakeProfitSnapshot,
} from '../../shared/lib/takeProfitSell';
import { toNumber, unwrapResult } from '../../shared/lib/parse';
import type {
  CandleInterval,
  CreateOrderPayload,
  HoldingItem,
  Order,
  OrderSubmitOptions,
  OrderSubmitResult,
} from '../types';

export function StockPage() {
  // 1. 상태(state) or hook
  const { symbol: routeSymbol } = useParams<{ symbol?: string }>();
  const symbol = routeSymbol?.toUpperCase();
  const hasSymbol = Boolean(symbol);
  const { isReady, selectedAccountSeq, setBuyingPower, setTotalMarketValue, buyingPower } =
    useAppContext();
  const requireAccountSeq = useRequireAccountSeq();

  const [stockName, setStockName] = useState<string>();
  const [warnings, setWarnings] = useState<string[]>([]);
  const [candleInterval, setCandleInterval] = useState<CandleInterval>(getStoredCandleInterval);
  const [takeProfitRatePercent, setTakeProfitRatePercent] = useState(getStoredTakeProfitRate);
  const layoutRef = useRef<HTMLElement>(null);

  const {
    sellableQuantity,
    holding,
    openOrders,
    portfolioHoldings,
    portfolioOpenOrders,
    refreshTrade,
    applyTradeSnapshot,
    placeTakeProfitSell,
    executePostBuyTakeProfit,
    getCurrentTradeSnapshot,
    refreshTradeAfterOrder,
    cancelOrder,
    submitOrder,
    refreshPortfolioHoldings,
    refreshPortfolioOpenOrders,
    refreshBuyingPower,
    marketFetcher,
    commissionsFetcher,
    closedOrdersFetcher,
  } = useSymbolTrading({
    symbol,
    accountSeq: selectedAccountSeq,
    setBuyingPower,
  });

  const {
    data: usMarketCalendar,
    error: usMarketCalendarError,
    loading: usMarketCalendarLoading,
  } = usePolling({
    fetcher: calendarFetcher,
    intervalMs: MARKET_CALENDAR_POLL_MS,
    enabled: isReady,
    resetKey: 'us-market-calendar',
  });

  const [initialLoadPhase, setInitialLoadPhase] = useState(true);

  const effectiveMarketPollingEnabled = useMemo(() => {
    if (!isReady || !hasSymbol) return false;
    if (initialLoadPhase) return true;
    return shouldEnableRecurringMarketPolling(usMarketCalendar?.today);
  }, [isReady, hasSymbol, usMarketCalendar?.today, initialLoadPhase]);

  const effectiveAccountPollingEnabled = useMemo(() => {
    if (!isReady || !selectedAccountSeq) return false;
    if (initialLoadPhase) return true;
    return !usMarketCalendar?.today || shouldEnableRecurringMarketPolling(usMarketCalendar.today);
  }, [isReady, selectedAccountSeq, usMarketCalendar?.today, initialLoadPhase]);

  const {
    candles,
    error: candlesError,
    loading: candlesLoading,
    loadingOlder: candlesLoadingOlder,
    hasMoreHistory,
    loadOlder: loadOlderCandles,
    refreshNow: refreshCandlesNow,
  } = useChartCandles(symbol ?? '', candleInterval, effectiveMarketPollingEnabled, {
    pollIntervalMs: CANDLE_POLL_MS,
    initialDelayMs: CANDLE_INITIAL_DELAY_MS,
  });

  const { refreshNow: refreshTradeNow } = usePolling({
    fetcher: refreshTrade,
    intervalMs: TRADE_POLL_MS,
    enabled: effectiveMarketPollingEnabled && Boolean(selectedAccountSeq),
    resetKey: `${selectedAccountSeq ?? ''}:${symbol ?? ''}`,
    options: { initialDelayMs: TRADE_INITIAL_DELAY_MS },
  });

  const { refreshing: portfolioHoldingsRefreshing } = usePolling({
    fetcher: refreshPortfolioHoldings,
    intervalMs: HOLDINGS_POLL_MS,
    enabled: effectiveAccountPollingEnabled,
    resetKey: `holdings:${selectedAccountSeq ?? ''}`,
    options: { initialDelayMs: PORTFOLIO_INITIAL_DELAY_MS },
  });

  const { data: marketData, refreshNow: refreshMarketNow } = usePolling({
    fetcher: marketFetcher,
    intervalMs: MARKET_POLL_MS,
    enabled: effectiveMarketPollingEnabled,
    resetKey: symbol ?? '',
    options: { initialDelayMs: MARKET_INITIAL_DELAY_MS },
  });

  const { data: commissions } = usePolling({
    fetcher: commissionsFetcher,
    intervalMs: COMMISSIONS_POLL_MS,
    enabled: effectiveAccountPollingEnabled,
    resetKey: `commissions:${selectedAccountSeq ?? ''}`,
  });

  const { data: closedOrdersState } = usePolling({
    fetcher: closedOrdersFetcher,
    intervalMs: CLOSED_ORDERS_POLL_MS,
    enabled: effectiveAccountPollingEnabled && hasSymbol,
    resetKey: `closed-orders:${selectedAccountSeq ?? ''}:${symbol ?? ''}`,
  });

  // 2. 일반 const
  const holdingSummary = useMemo(() => {
    if (!holding || holding.quantity <= 0) return undefined;

    const marketValue =
      marketData?.price !== undefined ? holding.quantity * marketData.price : holding.marketValue;
    const purchaseAmount =
      holding.purchaseAmount ??
      (holding.averagePrice !== undefined ? holding.quantity * holding.averagePrice : undefined);

    if (marketValue === undefined || purchaseAmount === undefined) {
      return {
        quantity: holding.quantity,
        averagePrice: holding.averagePrice,
        marketValue: holding.marketValue,
        profitLoss: holding.profitLoss,
        profitLossRate: holding.profitLossRate,
      };
    }

    const { profitLoss, profitLossRate } = resolveLiveProfitLoss(holding, marketValue);

    return {
      quantity: holding.quantity,
      averagePrice: holding.averagePrice,
      marketValue,
      profitLoss,
      profitLossRate,
    };
  }, [holding, marketData?.price]);

  const portfolioTotals = useMemo(() => {
    const totalMarketValue = portfolioHoldings.reduce(
      (sum, item) => sum + (item.marketValue ?? 0),
      0
    );
    const totalPurchaseAmount = portfolioHoldings.reduce(
      (sum, item) => sum + (item.purchaseAmount ?? 0),
      0
    );
    const totalProfitLoss =
      portfolioHoldings.length > 0
        ? portfolioHoldings.reduce((sum, item) => sum + (item.profitLoss ?? 0), 0)
        : undefined;
    const totalProfitLossRate =
      totalPurchaseAmount > 0 && totalProfitLoss !== undefined
        ? totalProfitLoss / totalPurchaseAmount
        : undefined;

    return { totalMarketValue, totalProfitLoss, totalProfitLossRate };
  }, [portfolioHoldings]);

  const averagePrice = holding && holding.quantity > 0 ? holding.averagePrice : undefined;

  const commissionRatePercent = useMemo(
    () => resolveUsCommissionRatePercent(commissions),
    [commissions]
  );

  const marketPanelProps = useMemo(
    () => ({
      symbol,
      stockName,
      bids: marketData?.bids,
      asks: marketData?.asks,
      trades: marketData?.trades,
      candles,
      averagePrice,
      currentPrice: marketData?.price,
      holding: holding && holding.quantity > 0 ? holding : undefined,
      holdingProfitLossRate: holdingSummary?.profitLossRate,
      targetProfitRatePercent: takeProfitRatePercent,
      usMarketDay: usMarketCalendar?.today,
      usMarketCalendarError,
      usMarketCalendarLoading,
      openOrders,
      closedOrders: closedOrdersState?.orders,
      closedOrdersUnavailable: closedOrdersState?.unavailable,
      buyingPower,
      sellableQuantity,
      commissions,
      candleInterval,
      onCandleIntervalChange: handleCandleIntervalChange,
      candlesLoading,
      candlesLoadingOlder,
      candlesError,
      hasMoreHistory,
      onLoadOlderCandles: loadOlderCandles,
      warnings,
    }),
    [
      averagePrice,
      buyingPower,
      candles,
      candlesError,
      candlesLoading,
      candlesLoadingOlder,
      candleInterval,
      closedOrdersState?.orders,
      closedOrdersState?.unavailable,
      commissions,
      handleCandleIntervalChange,
      hasMoreHistory,
      holding,
      holdingSummary?.profitLossRate,
      loadOlderCandles,
      marketData,
      openOrders,
      sellableQuantity,
      stockName,
      symbol,
      takeProfitRatePercent,
      usMarketCalendar?.today,
      usMarketCalendarError,
      usMarketCalendarLoading,
      warnings,
    ]
  );

  // 3. 함수 (메소드 & 핸들러) - get/set/on/handle 접두사로 목적 명확히
  const calendarFetcher = useCallback(async () => {
    return unwrapResult(await api.getUsMarketCalendar());
  }, []);





  const handleTakeProfitRateChange = useCallback((rate: number) => {
    setTakeProfitRatePercent(rate);
    setStoredTakeProfitRate(rate);
  }, []);

  const handleCandleIntervalChange = useCallback((interval: CandleInterval) => {
    setCandleInterval(interval);
    setStoredCandleInterval(interval);
  }, []);

  const handleCreateOrder = async (
    payload: CreateOrderPayload,
    options?: OrderSubmitOptions
  ): Promise<OrderSubmitResult> => {
    const accountSeq = requireAccountSeq();
    const openOrdersBaselineSignature = getOpenOrdersSignature(portfolioOpenOrders);

    const result = await submitOrder(payload, options, {
      refreshMarketNow,
      refreshCandlesNow,
      refreshBuyingPower,
      refreshPortfolioHoldings,
      refreshPortfolioOpenOrders,
    });

    // 최종 포트폴리오 오픈오더 refresh (훅 외부 UI 동기화)
    await refreshPortfolioOpenOrders(accountSeq);

    return result;
  };

  const handleCancelOrder = async (orderId: string) => {
    const accountSeq = requireAccountSeq();

    await cancelOrder(orderId);
    await refreshOpenOrdersAfterCancelForAccount({ accountSeq, cancelledOrderId: orderId });
    await Promise.all([refreshBuyingPower(accountSeq), refreshPortfolioHoldings()]);

    if (!symbol) return;

    // 훅의 refreshTrade가 fetch + apply를 담당
    await refreshTrade();
    refreshTradeNow();
  };

  // 4. useEffect (side effect 로직은 return 직전)
  useEffect(() => {
    if (!symbol) return;
    setLastSelectedSymbol(symbol);
  }, [symbol]);

  useEffect(() => {
    if (!selectedAccountSeq) {
      setTotalMarketValue(undefined);
      return;
    }
    // portfolio 상태는 이제 훅이 소유하므로, 필요시 훅의 refresh 호출
    void refreshPortfolioHoldings();
  }, [selectedAccountSeq, refreshPortfolioHoldings]);

  useEffect(() => {
    const total = portfolioHoldings.reduce((sum, item) => sum + (item.marketValue ?? 0), 0);
    setTotalMarketValue(total);
  }, [portfolioHoldings, setTotalMarketValue]);

  useEffect(() => {
    if (!isReady || !symbol) return;

    let cancelled = false;

    const loadStockMeta = async () => {
      try {
        const stockRes = await api.getStock(symbol);
        if (cancelled) return;

        const stock = unwrapResult(stockRes)[0];
        setStockName(stock?.englishName ?? stock?.name);

        const warningsRes = await api
          .getWarnings(symbol)
          .catch(() => ({ result: [] as { warningType: string }[] }));
        if (cancelled) return;

        setWarnings(unwrapResult(warningsRes).map((warning) => warning.warningType));
      } catch {
        if (!cancelled) {
          setStockName(undefined);
          setWarnings([]);
        }
      }
    };

    void loadStockMeta();

    return () => {
      cancelled = true;
    };
  }, [isReady, symbol]);

  // 포트폴리오 오픈오더 초기 로드는 훅 내부 또는 다른 곳에서 (initial phase 가드 적용됨)


  useEffect(() => {
    const searchInput = document.getElementById('symbol-search');
    if (searchInput instanceof HTMLElement) {
      searchInput.blur();
    }
    layoutRef.current?.focus({ preventScroll: true });
  }, [symbol]);

  useEffect(() => {
    const timer = setTimeout(() => setInitialLoadPhase(false), 8000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <>
      <main
        ref={layoutRef}
        className={`trading-layout${hasSymbol ? '' : ' trading-layout--portfolio-only'}`}
        tabIndex={-1}
      >
        <div className="trading-layout__main">
          {hasSymbol && symbol ? (
            <>
              <MarketPanel {...marketPanelProps} />
              <section className="order-column">
                <OrderForm
                  symbol={symbol}
                  currentPrice={marketData?.price}
                  buyingPower={buyingPower}
                  sellableQuantity={sellableQuantity}
                  holdingQuantity={holdingSummary?.quantity}
                  holdingAveragePrice={holdingSummary?.averagePrice}
                  holdingMarketValue={holdingSummary?.marketValue}
                  holdingProfitLoss={holdingSummary?.profitLoss}
                  holdingProfitLossRate={holdingSummary?.profitLossRate}
                  takeProfitRatePercent={takeProfitRatePercent}
                  onTakeProfitRateChange={handleTakeProfitRateChange}
                  commissionRatePercent={commissionRatePercent}
                  candles={candles}
                  candleInterval={candleInterval}
                  bids={marketData?.bids}
                  asks={marketData?.asks}
                  trades={marketData?.trades}
                  holding={holding && holding.quantity > 0 ? holding : undefined}
                  openOrders={openOrders}
                  onSubmit={handleCreateOrder}
                />
              </section>
            </>
          ) : (
            <section className="trading-welcome panel">
              <h2>내 포트폴리오</h2>
              <p className="hint">
                우측 보유 종목을 선택하거나 상단 검색으로 종목을 고르면 차트와 주문 화면이 열립니다.
              </p>
            </section>
          )}
        </div>
        <PortfolioSidebar
          buyingPower={buyingPower}
          totalMarketValue={portfolioTotals.totalMarketValue}
          totalProfitLoss={portfolioTotals.totalProfitLoss}
          totalProfitLossRate={portfolioTotals.totalProfitLossRate}
          holdings={portfolioHoldings}
          openOrders={portfolioOpenOrders}
          activeSymbol={symbol}
          holdingsPollIntervalMs={HOLDINGS_POLL_MS}
          holdingsRefreshing={portfolioHoldingsRefreshing}
          onCancelOrder={handleCancelOrder}
        />
      </main>
    </>
  );
}

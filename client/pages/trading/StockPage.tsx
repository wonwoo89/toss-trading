import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../shared/api/client';
import { MarketPanel } from "../widgets/MarketPanel';
import { OrderForm } from "../widgets/OrderForm';
import { PortfolioSidebar } from "../widgets/PortfolioSidebar';

import { useAppContext, useRequireAccountSeq } from '../../app/providers/AppContext';
import { useChartCandles } from '../hooks/useChartCandles';
import { usePolling } from '../hooks/usePolling';
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
} from '../hooks/useSymbolTrading';
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
  const [portfolioHoldings, setPortfolioHoldings] = useState<HoldingItem[]>(() =>
    getCachedHoldings(selectedAccountSeq)
  );
  const [portfolioOpenOrders, setPortfolioOpenOrders] = useState<Order[]>(() =>
    getCachedOpenOrders(selectedAccountSeq)
  );
  const layoutRef = useRef<HTMLElement>(null);

  // trade snapshot 상태(holding, openOrders, sellableQuantity)와 refresh/apply 로직은 훅이 소유
  const {
    sellableQuantity,
    holding,
    openOrders,
    refreshTrade,
    applyTradeSnapshot,
    placeTakeProfitSell,
    executePostBuyTakeProfit,
    getCurrentTradeSnapshot,
  } = useSymbolTrading({
    symbol,
    accountSeq: selectedAccountSeq,
  });

  // 주말/휴장 폴링 가드를 일찍 선언 (useChartCandles 등에서 사용하기 때문에 선언 순서 중요)
  const calendarFetcher = useCallback(async () => {
    return unwrapResult(await api.getUsMarketCalendar());
  }, []);

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

  // 최초 랜딩/새로고침 시점에는 1회 데이터 fetch를 강제 (주말/휴장 가드와 무관)
  // 일정 시간 후에는 recurring polling 가드만 적용
  const [initialLoadPhase, setInitialLoadPhase] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setInitialLoadPhase(false), 8000);
    return () => clearTimeout(timer);
  }, []);

  // market 폴링 enabled: initial phase 동안은 무조건 1회 허용, 이후 closed 가드
  const effectiveMarketPollingEnabled = useMemo(() => {
    if (!isReady || !hasSymbol) return false;
    if (initialLoadPhase) return true;
    return shouldEnableRecurringMarketPolling(usMarketCalendar?.today);
  }, [isReady, hasSymbol, usMarketCalendar?.today, initialLoadPhase]);

  // account/snapshot 폴링 enabled: initial phase 동안 1회 허용, 이후 closed 가드
  const effectiveAccountPollingEnabled = useMemo(() => {
    if (!isReady || !selectedAccountSeq) return false;
    if (initialLoadPhase) return true;
    return !usMarketCalendar?.today || shouldEnableRecurringMarketPolling(usMarketCalendar.today);
  }, [isReady, selectedAccountSeq, usMarketCalendar?.today, initialLoadPhase]);

  useEffect(() => {
    if (!symbol) return;
    setLastSelectedSymbol(symbol);
  }, [symbol]);

  useEffect(() => {
    if (!selectedAccountSeq) {
      setPortfolioHoldings([]);
      setPortfolioOpenOrders([]);
      setTotalMarketValue(undefined);
      return;
    }

    setPortfolioHoldings(getCachedHoldings(selectedAccountSeq));
    setPortfolioOpenOrders(getCachedOpenOrders(selectedAccountSeq));
  }, [selectedAccountSeq, setTotalMarketValue]);

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

  const refreshPortfolioHoldings = useCallback(async () => {
    if (!selectedAccountSeq) return;

    const snapshot = unwrapResult(await api.getPortfolioSnapshot(selectedAccountSeq));
    const mapped = mapHoldings(snapshot.holdings);

    setBuyingPower(toNumber(snapshot.buyingPower.cashBuyingPower));
    setPortfolioHoldings(mapped);
    savePortfolioHoldings(selectedAccountSeq, mapped);
  }, [selectedAccountSeq, setBuyingPower]);

  const refreshPortfolioOpenOrders = useCallback(
    async (accountSeq?: string) => {
      const targetAccountSeq = accountSeq ?? selectedAccountSeq;
      if (!targetAccountSeq) return;

      const orders = unwrapResult(await api.getAllOpenOrders(targetAccountSeq));
      const mapped = mapOrders(orders);

      setPortfolioOpenOrders(mapped);
      savePortfolioOpenOrders(targetAccountSeq, mapped);
    },
    [selectedAccountSeq]
  );

  const refreshOpenOrdersAfterCreateForAccount = useCallback(
    async (params: {
      accountSeq: string;
      baselineSignature: string;
      createdOrderId?: string;
      orderType?: 'LIMIT' | 'MARKET';
    }) => {
      const { accountSeq, baselineSignature, createdOrderId, orderType = 'LIMIT' } = params;
      await refreshOpenOrdersAfterCreate(
        () => refreshPortfolioOpenOrders(accountSeq),
        () => getCachedOpenOrders(accountSeq),
        baselineSignature,
        createdOrderId,
        orderType
      );
    },
    [refreshPortfolioOpenOrders]
  );

  const refreshOpenOrdersAfterCancelForAccount = useCallback(
    async (params: { accountSeq: string; cancelledOrderId: string }) => {
      const { accountSeq, cancelledOrderId } = params;
      await refreshOpenOrdersAfterCancel(
        () => refreshPortfolioOpenOrders(accountSeq),
        () => getCachedOpenOrders(accountSeq),
        cancelledOrderId
      );
    },
    [refreshPortfolioOpenOrders]
  );

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

  useEffect(() => {
    if (!isReady || !selectedAccountSeq) return;

    const timer = setTimeout(() => {
      void refreshPortfolioOpenOrders();
    }, PORTFOLIO_INITIAL_DELAY_MS);

    return () => clearTimeout(timer);
  }, [isReady, selectedAccountSeq, refreshPortfolioOpenOrders]);

  const refreshBuyingPower = useCallback(
    async (accountSeq: string) => {
      const buyingPowerRes = await api.getBuyingPower(accountSeq).catch(() => null);
      if (buyingPowerRes) {
        setBuyingPower(toNumber(unwrapResult(buyingPowerRes).cashBuyingPower));
      }
    },
    [setBuyingPower]
  );

  useEffect(() => {
    const searchInput = document.getElementById('symbol-search');
    if (searchInput instanceof HTMLElement) {
      searchInput.blur();
    }
    layoutRef.current?.focus({ preventScroll: true });
  }, [symbol]);

  const marketFetcher = useCallback(async () => {
    if (!symbol) throw new Error('종목이 선택되지 않았습니다.');

    const snapshot = unwrapResult(await api.getMarketSnapshot(symbol));
    const price = snapshot.price[0];
    const orderbook = snapshot.orderbook;
    const trades = snapshot.trades;

    return {
      price: toNumber(price?.lastPrice),
      bids: orderbook.bids.map((entry) => ({
        price: toNumber(entry.price) ?? 0,
        quantity: toNumber(entry.volume) ?? 0,
      })),
      asks: orderbook.asks.map((entry) => ({
        price: toNumber(entry.price) ?? 0,
        quantity: toNumber(entry.volume) ?? 0,
      })),
      trades: trades.map((trade) => ({
        price: toNumber(trade.price) ?? 0,
        quantity: toNumber(trade.volume) ?? 0,
        timestamp: trade.timestamp,
      })),
    };
  }, [symbol]);

  const { data: marketData, refreshNow: refreshMarketNow } = usePolling({
    fetcher: marketFetcher,
    intervalMs: MARKET_POLL_MS,
    enabled: effectiveMarketPollingEnabled,
    resetKey: symbol ?? '',
    options: { initialDelayMs: MARKET_INITIAL_DELAY_MS },
  });

  const commissionsFetcher = useCallback(async () => {
    if (!selectedAccountSeq) return [];
    return unwrapResult(await api.getCommissions(selectedAccountSeq));
  }, [selectedAccountSeq]);

  const { data: commissions } = usePolling({
    fetcher: commissionsFetcher,
    intervalMs: COMMISSIONS_POLL_MS,
    enabled: effectiveAccountPollingEnabled,
    resetKey: `commissions:${selectedAccountSeq ?? ''}`,
  });

  const closedOrdersFetcher = useCallback(async () => {
    if (!selectedAccountSeq || !symbol) {
      return { orders: [] as Order[], unavailable: false };
    }

    try {
      const page = unwrapResult(
        await api.getOrders({ status: 'CLOSED', symbol }, selectedAccountSeq)
      );
      return { orders: mapOrders(page), unavailable: false };
    } catch {
      return { orders: [] as Order[], unavailable: true };
    }
  }, [selectedAccountSeq, symbol]);

  const { data: closedOrdersState } = usePolling({
    fetcher: closedOrdersFetcher,
    intervalMs: CLOSED_ORDERS_POLL_MS,
    enabled: effectiveAccountPollingEnabled && hasSymbol,
    resetKey: `closed-orders:${selectedAccountSeq ?? ''}:${symbol ?? ''}`,
  });

  const handleTakeProfitRateChange = useCallback((rate: number) => {
    setTakeProfitRatePercent(rate);
    setStoredTakeProfitRate(rate);
  }, []);

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
    const baselineQuantity = holding?.quantity ?? 0;
    const tradeBaseline = getCurrentTradeSnapshot();

    const createdOrder = unwrapResult(await api.createOrder(payload, accountSeq));
    await refreshOpenOrdersAfterCreateForAccount({
      accountSeq,
      baselineSignature: openOrdersBaselineSignature,
      createdOrderId: createdOrder.orderId,
      orderType: payload.orderType,
    });

    refreshMarketNow();
    refreshCandlesNow();

    let state = await fetchTradeSnapshotWithRetry(symbol, accountSeq, tradeBaseline);
    applyTradeSnapshot(state);
    refreshTradeNow();
    await Promise.all([refreshBuyingPower(accountSeq), refreshPortfolioHoldings()]);

    let takeProfitSell: OrderSubmitResult['takeProfitSell'];

    if (payload.side === 'BUY' && options?.takeProfitSell) {
      takeProfitSell = await executePostBuyTakeProfit(
        options.takeProfitSell.profitRatePercent,
        payload.quantity,
        baselineQuantity,
        state
      ).catch((error: unknown) => ({
        placed: false,
        message:
          error instanceof Error
            ? `목표 수익률 매도 주문 실패: ${error.message}`
            : '목표 수익률 매도 주문에 실패했습니다.',
      }));

      if (takeProfitSell?.placed) {
        const openOrdersBeforeTakeProfit = getOpenOrdersSignature(getCachedOpenOrders(accountSeq));

        await refreshTrade();
        refreshTradeNow();
        await Promise.all([refreshBuyingPower(accountSeq), refreshPortfolioHoldings()]);
        await refreshOpenOrdersAfterCreateForAccount({
          accountSeq,
          baselineSignature: openOrdersBeforeTakeProfit,
          createdOrderId: takeProfitSell.orderId,
          orderType: 'LIMIT',
        });
      }
    }

    await refreshPortfolioOpenOrders(accountSeq);

    return { takeProfitSell };
  };

  const handleCancelOrder = async (orderId: string) => {
    const accountSeq = requireAccountSeq();

    await api.cancelOrder(orderId, accountSeq);
    await refreshOpenOrdersAfterCancelForAccount({ accountSeq, cancelledOrderId: orderId });
    await Promise.all([refreshBuyingPower(accountSeq), refreshPortfolioHoldings()]);

    if (!symbol) return;

    // 훅의 refreshTrade가 fetch + apply를 담당
    await refreshTrade();
    refreshTradeNow();
  };

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

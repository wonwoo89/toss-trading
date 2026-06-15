import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePolling } from '../../shared/hooks/usePolling';
import { useChartCandles } from '../../shared/hooks/useChartCandles';
import { useAppContext } from '../../app/providers/AppContext';
import { api } from '../../shared/api/client';
import { getPortfolioCache, upsertPortfolioHolding } from '../../shared/lib/portfolioCache';
import {
  mapHoldings,
  mapOrders,
  resolveLiveProfitLoss,
  selectHoldingBySymbol,
  sortHoldingsByMarketValue,
} from '../../entities/position';
import {
  fetchTradeSnapshotState,
  fetchTradeSnapshotWithRetry,
} from '../../shared/lib/tradeSnapshot';
import {
  calculateTakeProfitSellPrice,
  getTakeProfitCostContext,
  resolveTakeProfitSellQuantity,
  waitForTakeProfitSnapshot,
} from '../../shared/lib/takeProfitSell';
import { toNumber, unwrapResult } from '../../shared/lib/parse';
import {
  getStoredCandleInterval,
  setStoredCandleInterval,
} from '../../shared/lib/candleIntervalPreference';
import {
  getStoredTakeProfitRate,
  setStoredTakeProfitRate,
} from '../../shared/lib/takeProfitRatePreference';
import {
  getStoredRealtimePollingForced,
  setStoredRealtimePollingForced,
} from '../../shared/lib/realtimePollingPreference';
import { setLastSelectedSymbol } from '../../shared/lib/lastSymbolPreference';
import {
  getOpenOrdersSignature,
  refreshOpenOrdersAfterCreate,
} from '../../shared/lib/refreshOpenOrders';
import {
  isUsMarketHoliday,
  isUsWeekend,
  shouldEnableRecurringMarketPolling,
} from '../../shared/lib/usMarketCalendar';
import { resolveUsCommissionRatePercent } from '../../shared/lib/commissionBreakEven';
import type {
  CandleInterval,
  CommissionRaw,
  CreateOrderPayload,
  HoldingItem,
  Order,
  OrderSubmitOptions,
  OrderSubmitResult,
  OrderbookEntryRaw,
  TradeRaw,
} from '../../shared/types';
import type { TradeSnapshotState } from '../../shared/lib/tradeSnapshot';

// Symbol trading 관련 폴링 주기 상수
export const MARKET_POLL_MS = 250;
export const MARKET_CALENDAR_POLL_MS = 60_000;
export const COMMISSIONS_POLL_MS = 300_000;
export const CLOSED_ORDERS_POLL_MS = 60_000;
export const CANDLE_POLL_MS = 500;
export const TRADE_POLL_MS = 15000;
export const HOLDINGS_POLL_MS = 5000;

export const MARKET_INITIAL_DELAY_MS = 0;
export const CANDLE_INITIAL_DELAY_MS = 500;
export const TRADE_INITIAL_DELAY_MS = 1000;
export const PORTFOLIO_INITIAL_DELAY_MS = 1000;

export function getCachedHoldings(accountSeq?: string) {
  if (!accountSeq) return [];
  return sortHoldingsByMarketValue(getPortfolioCache(accountSeq)?.holdings ?? []);
}

export function getCachedOpenOrders(accountSeq?: string) {
  if (!accountSeq) return [];
  return getPortfolioCache(accountSeq)?.openOrders ?? [];
}

// Symbol trading hook (per-symbol + portfolio state, all pollings/refresh/snapshot encapsulated)
export interface SymbolTradingOptions {
  symbol?: string;
  accountSeq?: string;
}

export function useSymbolTrading(
  options: SymbolTradingOptions & {
    setBuyingPower?: (value?: number) => void;
    setTotalMarketValue?: (value?: number) => void;
    currentPrice?: number;
  } = {}
) {
  const { symbol, accountSeq, setBuyingPower, setTotalMarketValue, currentPrice } = options;

  const { isReady: contextIsReady, buyingPower: contextBuyingPower } = useAppContext();

  // 주말/휴장 가드와 initial phase 를 훅 내부에서 완전 관리
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
    enabled: contextIsReady,
    resetKey: 'us-market-calendar',
  });

  const [initialLoadPhase, setInitialLoadPhase] = useState(true);
  const [closedMarketDone, setClosedMarketDone] = useState(false);
  const [closedCandlesDone, setClosedCandlesDone] = useState(false);
  const [closedAccountDone, setClosedAccountDone] = useState(false);

  // 실시간 폴링 강제 토글. ON 이면 isClosed/세션 게이팅을 무시하고 시세·캔들을 상시 폴링한다.
  const [realtimePollingForced, setRealtimePollingForced] = useState<boolean>(
    getStoredRealtimePollingForced
  );

  const handleRealtimePollingForcedChange = useCallback((forced: boolean) => {
    setRealtimePollingForced(forced);
    setStoredRealtimePollingForced(forced);
  }, []);

  useEffect(() => {
    // symbol 변경(새 랜딩)마다 초기 phase + closed flags 리셋
    // 폐장일: live market 1회, candles 1회, account 1회 각각 독립 보장
    setInitialLoadPhase(true);
    setClosedMarketDone(false);
    setClosedCandlesDone(false);
    setClosedAccountDone(false);
    const timer = setTimeout(() => setInitialLoadPhase(false), 8000);
    return () => clearTimeout(timer);
  }, [symbol]);

  const isClosed = useMemo(() => {
    if (isUsWeekend()) return true;
    return isUsMarketHoliday(usMarketCalendar?.today);
  }, [usMarketCalendar?.today]);

  const effectiveLiveMarketEnabled = useMemo(() => {
    if (!contextIsReady || !symbol) return false;
    // 토글 ON: 세션/주말 게이팅 무시하고 상시 폴링 (데이/프리/애프터 모두 동작)
    if (realtimePollingForced) return true;
    if (isClosed) {
      // 폐장일: live market (price/bids/asks for panels) 정확히 1회만
      return !closedMarketDone;
    }
    if (initialLoadPhase) return true;
    return shouldEnableRecurringMarketPolling(usMarketCalendar?.today);
  }, [
    contextIsReady,
    symbol,
    realtimePollingForced,
    isClosed,
    closedMarketDone,
    initialLoadPhase,
    usMarketCalendar?.today,
  ]);

  const effectiveCandlesEnabled = useMemo(() => {
    if (!contextIsReady || !symbol) return false;
    // 토글 ON: 세션/주말 게이팅 무시하고 상시 폴링
    if (realtimePollingForced) return true;
    if (isClosed) {
      // 폐장일: candles (차트) 정확히 1회만 (독립 보장)
      return !closedCandlesDone;
    }
    if (initialLoadPhase) return true;
    return shouldEnableRecurringMarketPolling(usMarketCalendar?.today);
  }, [
    contextIsReady,
    symbol,
    realtimePollingForced,
    isClosed,
    closedCandlesDone,
    initialLoadPhase,
    usMarketCalendar?.today,
  ]);

  const effectiveAccountPollingEnabled = useMemo(() => {
    if (!contextIsReady || !accountSeq) return false;
    if (isClosed) {
      // 폐장일: account (스냅샷/포트폴리오) 정확히 1회만
      return !closedAccountDone;
    }
    if (initialLoadPhase) return true;
    return !usMarketCalendar?.today || shouldEnableRecurringMarketPolling(usMarketCalendar.today);
  }, [
    contextIsReady,
    accountSeq,
    isClosed,
    closedAccountDone,
    initialLoadPhase,
    usMarketCalendar?.today,
  ]);

  // UI preference 상태 (candle interval, take profit rate) 를 먼저 선언 (후속 useChartCandles / pollers 의존)
  const [candleInterval, setCandleInterval] = useState<CandleInterval>(getStoredCandleInterval);
  const [takeProfitRatePercent, setTakeProfitRatePercent] =
    useState<number>(getStoredTakeProfitRate);

  const handleCandleIntervalChange = useCallback((interval: CandleInterval) => {
    setCandleInterval(interval);
    setStoredCandleInterval(interval);
  }, []);

  const handleTakeProfitRateChange = useCallback((rate: number) => {
    setTakeProfitRatePercent(rate);
    setStoredTakeProfitRate(rate);
  }, []);

  // symbol meta load (이름, 경고) — encapsulated here
  const [stockName, setStockName] = useState<string>();
  const [warnings, setWarnings] = useState<string[]>([]);

  const [sellableQuantity, setSellableQuantity] = useState<number>();
  const [holding, setHolding] = useState<HoldingItem>();
  const [openOrders, setOpenOrders] = useState<Order[]>([]);

  // 포트폴리오 전체 상태 (사이드바용)도 훅이 소유
  const [portfolioHoldings, setPortfolioHoldings] = useState<HoldingItem[]>(() =>
    getCachedHoldings(accountSeq)
  );
  const [portfolioOpenOrders, setPortfolioOpenOrders] = useState<Order[]>(() =>
    getCachedOpenOrders(accountSeq)
  );

  // account data pollings encapsulated in hook
  const commissionsFetcher = useCallback(async () => {
    if (!accountSeq) return [] as CommissionRaw[];
    if (isClosed && closedAccountDone) return [] as CommissionRaw[];
    return unwrapResult(await api.getCommissions(accountSeq));
  }, [accountSeq, isClosed, closedAccountDone]);

  const closedOrdersFetcher = useCallback(async () => {
    if (!accountSeq || !symbol) return { orders: [] as Order[], unavailable: false };
    if (isClosed && closedAccountDone) return { orders: [] as Order[], unavailable: false };
    try {
      const res = await api.getOrders({ status: 'CLOSED', symbol }, accountSeq);
      const orders = mapOrders(unwrapResult(res));
      return { orders, unavailable: false };
    } catch {
      return { orders: [] as Order[], unavailable: true };
    }
  }, [accountSeq, symbol, isClosed, closedAccountDone]);

  const marketFetcher = useCallback(async () => {
    if (!symbol) return undefined;
    // 토글 ON 이면 폐장 1회 가드를 우회해 계속 시세를 받아온다.
    if (isClosed && closedMarketDone && !realtimePollingForced) return undefined;
    try {
      const snap = unwrapResult(await api.getMarketSnapshot(symbol));
      const p = snap.price?.[0];
      const ob = snap.orderbook;
      const priceInfo = p as { lastPrice?: string; price?: string } | undefined;
      const computedPrice = toNumber(priceInfo?.lastPrice ?? priceInfo?.price);
      console.log(`[client] marketFetcher SUCCESS for ${symbol}: computedPrice=`, computedPrice, 'rawPrice0=', p);
      return {
        bids: (ob?.bids ?? []).map((b: OrderbookEntryRaw) => ({
          price: toNumber(b.price) ?? 0,
          quantity: toNumber(b.volume) ?? 0,
        })),
        asks: (ob?.asks ?? []).map((a: OrderbookEntryRaw) => ({
          price: toNumber(a.price) ?? 0,
          quantity: toNumber(a.volume) ?? 0,
        })),
        trades: (snap.trades ?? []).map((t: TradeRaw) => ({
          price: toNumber(t.price) ?? 0,
          quantity: toNumber(t.volume) ?? 0,
          timestamp: t.timestamp,
        })),
        price: computedPrice,
      };
    } catch (e) {
      console.warn(`[client] marketFetcher FAILED for ${symbol}:`, e);
      return undefined;
    }
  }, [symbol, isClosed, closedMarketDone, realtimePollingForced]);

  const commissionsPolling = usePolling({
    fetcher: commissionsFetcher,
    intervalMs: COMMISSIONS_POLL_MS,
    enabled: effectiveAccountPollingEnabled,
    resetKey: `commissions:${accountSeq ?? ''}`,
  });

  const closedOrdersPolling = usePolling({
    fetcher: closedOrdersFetcher,
    intervalMs: CLOSED_ORDERS_POLL_MS,
    enabled: effectiveAccountPollingEnabled && !!symbol,
    resetKey: `closed-orders:${accountSeq ?? ''}:${symbol ?? ''}`,
  });

  // 폐장일 account 데이터 (commissions/closedOrders) 1회 후 플래그
  useEffect(() => {
    if (isClosed && (commissionsPolling.data || closedOrdersPolling.data) && !closedAccountDone) {
      setClosedAccountDone(true);
    }
  }, [isClosed, commissionsPolling.data, closedOrdersPolling.data, closedAccountDone]);

  const marketPolling = usePolling({
    fetcher: marketFetcher,
    intervalMs: MARKET_POLL_MS,
    enabled: effectiveLiveMarketEnabled,
    resetKey: symbol ?? '',
    options: { initialDelayMs: MARKET_INITIAL_DELAY_MS },
  });

  // 폐장일 market 1회 후 플래그 (live price 데이터 도착 시)
  useEffect(() => {
    if (isClosed && marketPolling.data && !closedMarketDone) {
      setClosedMarketDone(true);
    }
  }, [isClosed, marketPolling.data, closedMarketDone]);

  const candlesData = useChartCandles(symbol ?? '', candleInterval, effectiveCandlesEnabled, {
    pollIntervalMs: CANDLE_POLL_MS,
    initialDelayMs: CANDLE_INITIAL_DELAY_MS,
  });

  // 폐장일 candles 1회 후 플래그 (차트 데이터 도착 시) — candlesData 선언 후에 위치
  useEffect(() => {
    if (isClosed && candlesData.candles.length > 0 && !closedCandlesDone) {
      setClosedCandlesDone(true);
    }
  }, [isClosed, candlesData.candles, closedCandlesDone]);

  const holdingSummary = useMemo(() => {
    if (!holding || holding.quantity <= 0) return undefined;

    const marketValue =
      currentPrice !== undefined ? holding.quantity * currentPrice : holding.marketValue;
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
  }, [holding, currentPrice]);

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

  // portfolio total 동기화 to context (for header etc)
  useEffect(() => {
    if (setTotalMarketValue) {
      setTotalMarketValue(portfolioTotals.totalMarketValue);
    }
  }, [portfolioTotals.totalMarketValue, setTotalMarketValue]);

  const tradeRefreshSeqRef = useRef(0);

  const applyTradeSnapshot = useCallback(
    (state: TradeSnapshotState) => {
      setSellableQuantity(state.sellableQuantity);
      setHolding(state.holding);
      setOpenOrders(state.openOrders);

      if (accountSeq) {
        if (state.holding && state.holding.quantity > 0) {
          upsertPortfolioHolding(accountSeq, state.holding);
        } else {
          upsertPortfolioHolding(accountSeq, {
            symbol: symbol ?? '',
            quantity: 0,
          });
        }
      }
    },
    [accountSeq, symbol]
  );

  const refreshTrade = useCallback(async () => {
    if (!accountSeq || !symbol) return;

    console.log(`[client] refreshTrade called for symbol=${symbol}`);
    const seq = ++tradeRefreshSeqRef.current;
    const state = await fetchTradeSnapshotState(symbol, accountSeq);
    if (seq === tradeRefreshSeqRef.current) {
      applyTradeSnapshot(state);
    }
    return state;
  }, [accountSeq, symbol, applyTradeSnapshot]);

  const resetTradeState = useCallback(() => {
    setSellableQuantity(undefined);
    setHolding(undefined);
    setOpenOrders([]);
  }, []);

  // symbol 변경 시 trade 상태 자동 리셋 (훅 내부에서 캡슐화)
  useEffect(() => {
    if (!symbol) {
      resetTradeState();
    }
  }, [symbol, resetTradeState]);

  // symbol 선택 시 per-symbol trade snapshot (sellableQuantity 포함) + market data refresh
  // Use prevSymbolRef to trigger exactly once per actual symbol change (prevents over-calling on re-renders)
  const prevSymbolRef = useRef<string | null>(null);
  useEffect(() => {
    if (contextIsReady && symbol && symbol !== prevSymbolRef.current) {
      prevSymbolRef.current = symbol;
      console.log(`[client] triggering initial refreshTrade + market refresh + buyingPower for symbol=${symbol} on load`);
      void refreshTrade();
      marketPolling.refreshNow?.();
      candlesData.refreshNow?.();
      if (accountSeq) {
        void refreshBuyingPower(accountSeq);
      }
    }
  }, [contextIsReady, symbol, refreshTrade, accountSeq]);

  // 마지막 선택 심볼 저장 (이전 StockPage useEffect 이동)
  useEffect(() => {
    if (!symbol) return;
    setLastSelectedSymbol(symbol);
  }, [symbol]);

  // symbol 메타 (stockName, warnings) 로드 — StockPage에서 이동 (api + isReady + symbol 의존)
  useEffect(() => {
    if (!contextIsReady || !symbol) return;

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
  }, [contextIsReady, symbol]);

  const placeTakeProfitSell = useCallback(
    async (
      profitRatePercent: number,
      boughtQuantity: number | undefined,
      baselineQuantity: number,
      state: TradeSnapshotState
    ): Promise<OrderSubmitResult['takeProfitSell']> => {
      const targetAccountSeq = accountSeq;
      if (!targetAccountSeq || !symbol) {
        return { placed: false, message: '계좌 또는 종목 정보가 없습니다.' };
      }

      const averagePrice = state.holding?.averagePrice;
      const sellQuantity = resolveTakeProfitSellQuantity(
        boughtQuantity,
        baselineQuantity,
        state.holding?.quantity
      );

      if (!averagePrice || averagePrice <= 0) {
        return {
          placed: false,
          message: '평단가를 확인하지 못해 목표 수익률 매도 주문을 넣지 못했습니다.',
        };
      }

      if (!sellQuantity || sellQuantity <= 0) {
        return {
          placed: false,
          message: '체결 수량을 확인하지 못해 목표 수익률 매도 주문을 넣지 못했습니다.',
        };
      }

      const sellPrice = calculateTakeProfitSellPrice(
        averagePrice,
        sellQuantity,
        profitRatePercent,
        getTakeProfitCostContext(state.holding)
      );

      const createdOrder = unwrapResult(
        await api.createOrder(
          {
            symbol: symbol.toUpperCase(),
            side: 'SELL',
            orderType: 'LIMIT',
            quantity: sellQuantity,
            price: sellPrice,
            clientOrderId: crypto.randomUUID(),
          },
          targetAccountSeq
        )
      );

      return {
        placed: true,
        price: sellPrice,
        quantity: sellQuantity,
        orderId: createdOrder.orderId,
        message: `세금·수수료 반영 ${profitRatePercent}% 실수익률 목표가 ${sellPrice.toFixed(2)} USD에 ${sellQuantity}주 매도 주문을 넣었습니다.`,
      };
    },
    [symbol, accountSeq]
  );

  const executePostBuyTakeProfit = useCallback(
    async (params: {
      profitRatePercent: number;
      boughtQuantity: number | undefined;
      baselineQuantity: number;
      initialState: TradeSnapshotState;
    }): Promise<OrderSubmitResult['takeProfitSell']> => {
      const { profitRatePercent, boughtQuantity, baselineQuantity, initialState } = params;
      let currentState = initialState;

      // waitForTakeProfitSnapshot은 hook 내부에서 처리 (랜딩 시 초기 요청은 허용하되, 주말 가드는 상위에서 이미 적용됨)
      if (
        !canPlaceTakeProfitSell(
          boughtQuantity,
          baselineQuantity,
          currentState.holding?.averagePrice,
          currentState.holding?.quantity
        )
      ) {
        currentState = await waitForTakeProfitSnapshot(
          () => fetchTradeSnapshotState(symbol!, accountSeq!),
          boughtQuantity,
          baselineQuantity,
          initialState
        );
        applyTradeSnapshot(currentState);
      }

      const result = await placeTakeProfitSell(
        profitRatePercent,
        boughtQuantity,
        baselineQuantity,
        currentState
      );

      return result;
    },
    [symbol, accountSeq, applyTradeSnapshot, placeTakeProfitSell]
  );

  // 작은 헬퍼 (takeProfitSell.ts에서 re-export 하지 않고 여기서 간단 사용)
  function canPlaceTakeProfitSell(
    boughtQuantity: number | undefined,
    baselineQuantity: number,
    averagePrice?: number,
    nextQuantity?: number
  ) {
    const sellQuantity = resolveTakeProfitSellQuantity(
      boughtQuantity,
      baselineQuantity,
      nextQuantity
    );
    return Boolean(averagePrice && averagePrice > 0 && sellQuantity && sellQuantity > 0);
  }

  const getCurrentTradeSnapshot = useCallback(
    (): TradeSnapshotState => ({
      holding,
      sellableQuantity,
      openOrders,
    }),
    [holding, sellableQuantity, openOrders]
  );

  // 주문 직후 공통으로 수행하는 trade snapshot refresh (호출부에서 withRetry + baseline 를 넘겨 사용)
  const refreshTradeAfterOrder = useCallback(
    async (baseline: TradeSnapshotState): Promise<TradeSnapshotState | undefined> => {
      if (!accountSeq || !symbol) return undefined;
      const state = await fetchTradeSnapshotWithRetry(symbol, accountSeq, baseline);
      applyTradeSnapshot(state);
      return state;
    },
    [accountSeq, symbol, applyTradeSnapshot]
  );

  // 포트폴리오 리프레시 함수들 (이제 훅 내부에서 set* 호출)
  // 이 블록을 앞으로 이동시켜 TDZ 방지 (cancelOrder, submitOrder 등이 의존)
  const refreshPortfolioHoldings = useCallback(async () => {
    if (!accountSeq) return;

    if (isClosed && closedAccountDone) {
      // 폐장일: account 스냅샷 1회 이후 스킵
      return;
    }

    const snapshot = unwrapResult(await api.getPortfolioSnapshot(accountSeq));
    const mapped = mapHoldings(snapshot.holdings);

    if (setBuyingPower) setBuyingPower(toNumber(snapshot.buyingPower.cashBuyingPower));
    setPortfolioHoldings(mapped);

    if (isClosed && !closedAccountDone) {
      setClosedAccountDone(true);
    }
    // savePortfolioHoldings(accountSeq, mapped); // 필요시 외부에서
  }, [accountSeq, setBuyingPower, isClosed, closedAccountDone]);

  // account 변경 시 포트폴리오 로드 트리거 (이전 StockPage useEffect 이동)
  useEffect(() => {
    if (accountSeq) {
      void refreshPortfolioHoldings();
    } else {
      if (setTotalMarketValue) setTotalMarketValue(undefined);
    }
  }, [accountSeq, refreshPortfolioHoldings, setTotalMarketValue]);

  const refreshPortfolioOpenOrders = useCallback(
    async (accSeq?: string) => {
      const target = accSeq ?? accountSeq;
      if (!target) return;

      const orders = unwrapResult(await api.getAllOpenOrders(target));
      const mapped = mapOrders(orders);

      setPortfolioOpenOrders(mapped);
      // savePortfolioOpenOrders(target, mapped);
    },
    [accountSeq]
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

  const refreshBuyingPower = useCallback(
    async (accSeq: string) => {
      console.log(`[client] refreshBuyingPower called for accountSeq=${accSeq}`);
      const buyingPowerRes = await api.getBuyingPower(accSeq).catch((e) => {
        console.warn(`[client] refreshBuyingPower api error for ${accSeq}:`, e);
        return null;
      });
      if (buyingPowerRes && setBuyingPower) {
        const bp = toNumber(unwrapResult(buyingPowerRes).cashBuyingPower);
        console.log(`[client] refreshBuyingPower SUCCESS, setting buyingPower=`, bp);
        setBuyingPower(bp);
      } else {
        console.log(`[client] refreshBuyingPower no res or no setter`);
      }
    },
    [setBuyingPower]
  );

  const cancelOrder = useCallback(
    async (orderId: string) => {
      if (!accountSeq) return;
      await api.cancelOrder(orderId, accountSeq);

      // cancel 후 포트폴리오/트레이드 동기화 (이전 StockPage handleCancel 로직 이동)
      await refreshPortfolioOpenOrders(accountSeq);
      await Promise.all([refreshBuyingPower(accountSeq), refreshPortfolioHoldings()]);

      if (symbol) {
        await refreshTrade();
      }
    },
    [
      accountSeq,
      symbol,
      refreshPortfolioOpenOrders,
      refreshBuyingPower,
      refreshPortfolioHoldings,
      refreshTrade,
    ]
  );

  // 전체 주문 제출 (create + trade refresh + optional take profit)
  // 3개 이상 side effect 콜백은 object payload로 (컨벤션)
  const submitOrder = useCallback(
    async (
      payload: CreateOrderPayload,
      options?: OrderSubmitOptions
    ): Promise<OrderSubmitResult> => {
      const acc = accountSeq!;
      const baselineSig = getOpenOrdersSignature([]); // baseline은 호출부 관리
      const baseQty = getCurrentTradeSnapshot().holding?.quantity ?? 0;
      const tradeBase = getCurrentTradeSnapshot();

      const created = unwrapResult(await api.createOrder(payload, acc));

      await refreshOpenOrdersAfterCreateForAccount({
        accountSeq: acc,
        baselineSignature: baselineSig,
        createdOrderId: created.orderId,
        orderType: payload.orderType,
      });

      // 내부 polling refresh (이전 외부 sideEffect 제거 — 훅이 소유)
      marketPolling.refreshNow?.();
      candlesData.refreshNow?.();

      const st = (await refreshTradeAfterOrder(tradeBase)) ?? tradeBase;
      await refreshBuyingPower(acc);
      await refreshPortfolioHoldings();

      let tp: OrderSubmitResult['takeProfitSell'];

      if (payload.side === 'BUY' && options?.takeProfitSell) {
        tp = await executePostBuyTakeProfit({
          profitRatePercent: options.takeProfitSell.profitRatePercent,
          boughtQuantity: payload.quantity,
          baselineQuantity: baseQty,
          initialState: st,
        }).catch((e: unknown) => ({
          placed: false,
          message:
            e instanceof Error
              ? `목표 수익률 매도 주문 실패: ${e.message}`
              : '목표 수익률 매도 주문 실패',
        }));

        if (tp?.placed) {
          const before = getOpenOrdersSignature(getCachedOpenOrders(acc));
          await refreshTrade();
          await refreshBuyingPower(acc);
          await refreshPortfolioHoldings();
          await refreshOpenOrdersAfterCreateForAccount({
            accountSeq: acc,
            baselineSignature: before,
            createdOrderId: tp.orderId,
            orderType: 'LIMIT',
          });
        }
      }

      await refreshPortfolioOpenOrders(acc);

      return { takeProfitSell: tp };
    },
    [
      accountSeq,
      getCurrentTradeSnapshot,
      refreshTradeAfterOrder,
      executePostBuyTakeProfit,
      getCachedOpenOrders,
      refreshTrade,
      refreshBuyingPower,
      refreshPortfolioHoldings,
      refreshPortfolioOpenOrders,
      marketPolling,
      candlesData,
    ]
  );

  // commission + marketPanelProps 는 이제 훅 내부에서 조립 (StockPage 경량화)
  const commissionRatePercent = useMemo(
    () => resolveUsCommissionRatePercent(commissionsPolling.data ?? undefined),
    [commissionsPolling.data]
  );

  // per-symbol trade snapshot 이 sellableQuantity 를 주지 않더라도
  // portfolio snapshot 의 holding.quantity 로 fallback 해서 "매도 가능" 이 항상 보이게 함
  const symbolHoldingFromPortfolio = selectHoldingBySymbol(portfolioHoldings, symbol);
  const effectiveHolding = holding ?? symbolHoldingFromPortfolio;
  const effectiveSellableQuantity =
    (sellableQuantity != null && sellableQuantity > 0)
      ? sellableQuantity
      : (effectiveHolding?.quantity ?? undefined);

  const marketPanelProps = useMemo(
    () => ({
      symbol,
      stockName,
      bids: marketPolling.data?.bids,
      asks: marketPolling.data?.asks,
      trades: marketPolling.data?.trades,
      candles: candlesData.candles,
      averagePrice: holding && holding.quantity > 0 ? holding.averagePrice : undefined,
      currentPrice: marketPolling.data?.price,
      holding: effectiveHolding && effectiveHolding.quantity > 0 ? effectiveHolding : undefined,
      holdingProfitLossRate: holdingSummary?.profitLossRate,
      targetProfitRatePercent: takeProfitRatePercent,
      usMarketDay: usMarketCalendar?.today,
      usMarketCalendarError,
      usMarketCalendarLoading,
      openOrders,
      closedOrders: closedOrdersPolling.data?.orders,
      closedOrdersUnavailable: closedOrdersPolling.data?.unavailable,
      buyingPower: contextBuyingPower,
      sellableQuantity: effectiveSellableQuantity,
      commissions: commissionsPolling.data ?? undefined,
      candleInterval,
      onCandleIntervalChange: handleCandleIntervalChange,
      candlesLoading: candlesData.loading,
      candlesLoadingOlder: candlesData.loadingOlder,
      candlesError: candlesData.error,
      hasMoreHistory: candlesData.hasMoreHistory,
      onLoadOlderCandles: candlesData.loadOlder,
      warnings,
      realtimePollingForced,
      onRealtimePollingForcedChange: handleRealtimePollingForcedChange,
    }),
    [
      symbol,
      stockName,
      marketPolling.data,
      candlesData.candles,
      holding,
      holdingSummary,
      takeProfitRatePercent,
      usMarketCalendar,
      usMarketCalendarError,
      usMarketCalendarLoading,
      openOrders,
      closedOrdersPolling.data,
      contextBuyingPower,
      effectiveSellableQuantity,
      commissionsPolling.data,
      candleInterval,
      handleCandleIntervalChange,
      candlesData.loading,
      candlesData.loadingOlder,
      candlesData.error,
      candlesData.hasMoreHistory,
      candlesData.loadOlder,
      warnings,
      realtimePollingForced,
      handleRealtimePollingForcedChange,
      portfolioHoldings,
    ]
  );

  // OrderForm 용 props bag (StockPage를 더 얇게 만들기 위한 다음 단계)
  const orderFormProps = useMemo(
    () => ({
      symbol,
      currentPrice: marketPolling.data?.price,
      buyingPower: contextBuyingPower,
      sellableQuantity: effectiveSellableQuantity,
      holdingQuantity: effectiveHolding?.quantity,
      holdingAveragePrice: holdingSummary?.averagePrice,
      holdingMarketValue: holdingSummary?.marketValue,
      holdingProfitLoss: holdingSummary?.profitLoss,
      holdingProfitLossRate: holdingSummary?.profitLossRate,
      takeProfitRatePercent,
      onTakeProfitRateChange: handleTakeProfitRateChange,
      commissionRatePercent,
      candles: candlesData.candles,
      candleInterval,
      onCandleIntervalChange: handleCandleIntervalChange,
      bids: marketPolling.data?.bids,
      asks: marketPolling.data?.asks,
      trades: marketPolling.data?.trades,
      holding: effectiveHolding && effectiveHolding.quantity > 0 ? effectiveHolding : undefined,
      openOrders,
    }),
    [
      symbol,
      marketPolling.data,
      contextBuyingPower,
      effectiveSellableQuantity,
      effectiveHolding,
      takeProfitRatePercent,
      handleTakeProfitRateChange,
      commissionRatePercent,
      candlesData.candles,
      candleInterval,
      handleCandleIntervalChange,
      marketPolling.data?.bids,
      marketPolling.data?.asks,
      marketPolling.data?.trades,
      openOrders,
      portfolioHoldings,
    ]
  );

  return {
    symbol,
    accountSeq,
    sellableQuantity,
    holding,
    openOrders,
    portfolioHoldings,
    portfolioOpenOrders,
    getCachedHoldings: () => getCachedHoldings(accountSeq),
    getCachedOpenOrders: () => getCachedOpenOrders(accountSeq),
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
    holdingSummary,
    portfolioTotals,
    candleInterval,
    takeProfitRatePercent,
    handleCandleIntervalChange,
    handleTakeProfitRateChange,
    realtimePollingForced,
    handleRealtimePollingForcedChange,
    commissions: commissionsPolling.data,
    closedOrdersState: closedOrdersPolling.data,
    marketData: marketPolling.data,
    refreshMarketNow: marketPolling.refreshNow,
    candles: candlesData.candles,
    candlesError: candlesData.error,
    candlesLoading: candlesData.loading,
    candlesLoadingOlder: candlesData.loadingOlder,
    hasMoreHistory: candlesData.hasMoreHistory,
    loadOlderCandles: candlesData.loadOlder,
    refreshCandlesNow: candlesData.refreshNow,
    usMarketCalendar,
    usMarketCalendarError,
    usMarketCalendarLoading,
    marketPanelProps,
    commissionRatePercent,
    orderFormProps,
  };
}

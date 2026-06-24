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
import {
  getStoredHiddenSymbols,
  setStoredHiddenSymbols,
} from '../../shared/lib/hiddenHoldingsPreference';
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
import { mapApiCandles } from '../../shared/lib/candles';
import { resolvePreviousClose } from '../../shared/lib/marketAnalytics';
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
export const MARKET_POLL_MS = 500;
export const MARKET_CALENDAR_POLL_MS = 60_000;
export const COMMISSIONS_POLL_MS = 300_000;
export const CLOSED_ORDERS_POLL_MS = 60_000;
export const CANDLE_POLL_MS = 500;
export const TRADE_POLL_MS = 15000;
export const HOLDINGS_POLL_MS = 2000;

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
  const [previousClose, setPreviousClose] = useState<number>();
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

  // 자산에서 제외(숨김)할 종목 — localStorage 영속. 토스 앱의 "숨김"을 WTS 에서 재현.
  const [hiddenSymbols, setHiddenSymbols] = useState<string[]>(getStoredHiddenSymbols);

  const toggleHiddenSymbol = useCallback((sym: string) => {
    const upper = sym.toUpperCase();
    setHiddenSymbols((prev) => {
      const next = prev.includes(upper)
        ? prev.filter((s) => s !== upper)
        : [...prev, upper];
      setStoredHiddenSymbols(next);
      return next;
    });
  }, []);

  const hiddenSymbolSet = useMemo(
    () => new Set(hiddenSymbols.map((s) => s.toUpperCase())),
    [hiddenSymbols]
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

  // 렌더마다 최신 symbol. 종목 변경 후 늦게 도착한 이전 종목 시세(stale)를 폐기하는 데 사용.
  const latestSymbolRef = useRef(symbol);
  latestSymbolRef.current = symbol;

  const marketFetcher = useCallback(async () => {
    if (!symbol) return undefined;
    // 토글 ON 이면 폐장 1회 가드를 우회해 계속 시세를 받아온다.
    if (isClosed && closedMarketDone && !realtimePollingForced) return undefined;
    try {
      const snap = unwrapResult(await api.getMarketSnapshot(symbol));
      // 응답 도착 시점에 종목이 바뀌었으면 stale → undefined 반환(usePolling 이 직전 시세 유지).
      if (symbol !== latestSymbolRef.current) return undefined;
      const p = snap.price?.[0];
      const ob = snap.orderbook;
      const priceInfo = p as
        | { lastPrice?: string; price?: string; currency?: string }
        | undefined;
      const computedPrice = toNumber(priceInfo?.lastPrice ?? priceInfo?.price);
      return {
        currency: priceInfo?.currency,
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
    } catch {
      // 시세 조회 실패 시 undefined 반환 → usePolling 이 직전 시세를 유지(깜빡임 방지).
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

  // 포트폴리오 스냅샷(보유 목록 + 매수가능) 인터벌 폴링.
  // 기존엔 계좌 변경/주문 직후에만 갱신돼 목록이 주기적으로 안 바뀌었다. 실시간 토글 ON 이면
  // 폐장에도 계속 갱신해 평가금액(연장 시세 반영)을 따라간다.
  const portfolioSnapshotFetcher = useCallback(async () => {
    if (!accountSeq) return null;
    if (isClosed && closedAccountDone && !realtimePollingForced) return null;
    return unwrapResult(await api.getPortfolioSnapshot(accountSeq));
  }, [accountSeq, isClosed, closedAccountDone, realtimePollingForced]);

  const portfolioPolling = usePolling({
    fetcher: portfolioSnapshotFetcher,
    intervalMs: HOLDINGS_POLL_MS,
    enabled: effectiveAccountPollingEnabled || realtimePollingForced,
    resetKey: `portfolio:${accountSeq ?? ''}`,
    options: { initialDelayMs: PORTFOLIO_INITIAL_DELAY_MS },
  });

  // 폴링 결과를 포트폴리오 상태에 반영 (보유 목록 + 매수가능 + 폐장 1회 플래그)
  useEffect(() => {
    const snap = portfolioPolling.data;
    if (!snap) return;
    setPortfolioHoldings(mapHoldings(snap.holdings));
    if (setBuyingPower) setBuyingPower(toNumber(snap.buyingPower.cashBuyingPower));
    if (isClosed && !closedAccountDone) setClosedAccountDone(true);
  }, [portfolioPolling.data, isClosed, closedAccountDone, setBuyingPower]);

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

    // 라이브 시세 우선 사용. options.currentPrice 가 없으면(StockPage 미전달) 시세 폴링값으로
    // 평가금액/수익률을 실시간 반영한다. 둘 다 없을 때만 스냅샷 marketValue 로 폴백.
    const livePrice = currentPrice ?? marketPolling.data?.price;
    const marketValue =
      livePrice !== undefined ? holding.quantity * livePrice : holding.marketValue;
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
  }, [holding, currentPrice, marketPolling.data?.price]);

  // 숨김 종목을 분리: 합계·헤더 총자산은 visible 기준, hidden 은 사이드바 접이식에만 노출.
  const visibleHoldings = useMemo(
    () => portfolioHoldings.filter((item) => !hiddenSymbolSet.has(item.symbol.toUpperCase())),
    [portfolioHoldings, hiddenSymbolSet]
  );
  const hiddenHoldings = useMemo(
    () => portfolioHoldings.filter((item) => hiddenSymbolSet.has(item.symbol.toUpperCase())),
    [portfolioHoldings, hiddenSymbolSet]
  );

  const portfolioTotals = useMemo(() => {
    // 총 투자 금액(사이드바 요약)은 숨김 종목을 제외한 visible 기준.
    const totalMarketValue = visibleHoldings.reduce(
      (sum, item) => sum + (item.marketValue ?? 0),
      0
    );
    // 총 계좌(헤더)는 숨김 종목까지 포함한 전체 평가금액 기준.
    const totalMarketValueAll = portfolioHoldings.reduce(
      (sum, item) => sum + (item.marketValue ?? 0),
      0
    );
    const totalPurchaseAmount = visibleHoldings.reduce(
      (sum, item) => sum + (item.purchaseAmount ?? 0),
      0
    );
    const totalProfitLoss =
      visibleHoldings.length > 0
        ? visibleHoldings.reduce((sum, item) => sum + (item.profitLoss ?? 0), 0)
        : undefined;
    const totalProfitLossRate =
      totalPurchaseAmount > 0 && totalProfitLoss !== undefined
        ? totalProfitLoss / totalPurchaseAmount
        : undefined;

    return { totalMarketValue, totalMarketValueAll, totalProfitLoss, totalProfitLossRate };
  }, [visibleHoldings, portfolioHoldings]);

  // 총 계좌(헤더)는 숨김 포함 전체 평가금액을 context 로 동기화한다.
  useEffect(() => {
    if (setTotalMarketValue) {
      setTotalMarketValue(portfolioTotals.totalMarketValueAll);
    }
  }, [portfolioTotals.totalMarketValueAll, setTotalMarketValue]);

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

  // 전일(직전 거래일) 종가 — 일봉 캔들 몇 개를 받아 산출. 전일대비 등락률 표시에 사용.
  // (prevClose 는 하루 동안 고정이므로 종목 변경 시 1회만 로드)
  useEffect(() => {
    if (!contextIsReady || !symbol) {
      setPreviousClose(undefined);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getCandles(symbol, '1d', 3);
        if (cancelled) return;
        const daily = mapApiCandles(unwrapResult(res).candles);
        setPreviousClose(resolvePreviousClose(daily));
      } catch {
        if (!cancelled) setPreviousClose(undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [contextIsReady, symbol]);

  const placeTakeProfitSell = useCallback(
    async (
      profitRatePercent: number,
      state: TradeSnapshotState
    ): Promise<OrderSubmitResult['takeProfitSell']> => {
      const targetAccountSeq = accountSeq;
      if (!targetAccountSeq || !symbol) {
        return { placed: false, message: '계좌 또는 종목 정보가 없습니다.' };
      }

      const averagePrice = state.holding?.averagePrice;
      // 매수 후 평단가 기준 목표 실수익률 매도는 새로 산 수량이 아니라
      // 총 보유수량 전체를 대상으로 한다(매수 반영 후 스냅샷 기준).
      // 지정가 매도는 정수 주(株)만 허용되므로 소수점 보유분은 내림 처리한다.
      const totalQuantity = state.holding?.quantity;
      const sellQuantity =
        totalQuantity !== undefined ? Math.floor(totalQuantity) : undefined;

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

      // 이미 걸려 있는 매도 대기 주문(이전 목표가 매도 등)이 있으면 취소한 뒤
      // 갱신된 총 보유수량으로 다시 건다. 취소가 매도 가능 수량에 반영될
      // 때까지 스냅샷을 재조회(openOrders 시그니처 변화 감지)한다.
      const pendingSells = currentState.openOrders.filter((o) => o.side === 'SELL');
      if (pendingSells.length > 0) {
        await Promise.all(
          pendingSells.map((o) =>
            api.cancelOrder(o.orderId, accountSeq!).catch(() => undefined)
          )
        );
        currentState = await fetchTradeSnapshotWithRetry(symbol!, accountSeq!, currentState);
        applyTradeSnapshot(currentState);
      }

      const result = await placeTakeProfitSell(profitRatePercent, currentState);

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

  // 매수/매도 체결 감지 → 미체결 주문 + 현재 종목 보유 스냅샷 갱신.
  // portfolioOpenOrders 와 holding(평단·수량)·sellableQuantity 는 인터벌 폴링이 없어,
  // 지정가/목표수익률/자동매매 주문이 나중에 체결돼도 새로고침 전엔 갱신되지 않았다.
  // 보유 수량은 포트폴리오 스냅샷(2초 폴링)으로 갱신되므로, 수량 변화(=체결)를 신호로 삼아
  // 미체결 주문과 함께 현재 종목 trade 스냅샷도 한 번 다시 불러온다(차트 평단·주문폼 보유 갱신).
  const holdingsQtySignatureRef = useRef<string | null>(null);
  useEffect(() => {
    const signature = portfolioHoldings
      .map((item) => `${item.symbol.toUpperCase()}:${item.quantity}`)
      .sort()
      .join('|');

    const prev = holdingsQtySignatureRef.current;
    holdingsQtySignatureRef.current = signature;

    // 최초 로드(기준선 설정)나 변화 없을 때는 트리거하지 않는다.
    if (prev === null || prev === signature) return;

    void refreshPortfolioOpenOrders();
    void refreshTrade(); // 체결 시 현재 종목 평단·보유수량·매도가능도 갱신
  }, [portfolioHoldings, refreshPortfolioOpenOrders, refreshTrade]);

  const refreshBuyingPower = useCallback(
    async (accSeq: string) => {
      const buyingPowerRes = await api.getBuyingPower(accSeq).catch(() => null);
      if (buyingPowerRes && setBuyingPower) {
        const bp = toNumber(unwrapResult(buyingPowerRes).cashBuyingPower);
        setBuyingPower(bp);
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
      previousClose,
      bids: marketPolling.data?.bids,
      asks: marketPolling.data?.asks,
      trades: marketPolling.data?.trades,
      candles: candlesData.candles,
      averagePrice: holding && holding.quantity > 0 ? holding.averagePrice : undefined,
      currentPrice: marketPolling.data?.price,
      currency: marketPolling.data?.currency ?? 'USD',
      holding: effectiveHolding && effectiveHolding.quantity > 0 ? effectiveHolding : undefined,
      holdingProfitLossRate: holdingSummary?.profitLossRate,
      targetProfitRatePercent: takeProfitRatePercent,
      usMarketCalendar,
      usMarketCalendarError,
      usMarketCalendarLoading,
      openOrders,
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
      previousClose,
      marketPolling.data,
      candlesData.candles,
      holding,
      holdingSummary,
      takeProfitRatePercent,
      usMarketCalendar,
      usMarketCalendarError,
      usMarketCalendarLoading,
      openOrders,
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
      currency: marketPolling.data?.currency ?? 'USD',
      previousClose,
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
      previousClose,
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
    visibleHoldings,
    hiddenHoldings,
    hiddenSymbols,
    toggleHiddenSymbol,
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
    holdingsRefreshing: portfolioPolling.refreshing,
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

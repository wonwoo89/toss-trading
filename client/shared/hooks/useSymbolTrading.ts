import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { getPortfolioCache, upsertPortfolioHolding } from '../lib/portfolioCache';
import { sortHoldingsByMarketValue } from '../lib/mapPortfolio';
import { fetchTradeSnapshotState, fetchTradeSnapshotWithRetry } from '../lib/tradeSnapshot';
import {
  calculateTakeProfitSellPrice,
  getTakeProfitCostContext,
  resolveTakeProfitSellQuantity,
  waitForTakeProfitSnapshot,
} from '../lib/takeProfitSell';
import { unwrapResult } from '../lib/parse';
import {
  getOpenOrdersSignature,
  refreshOpenOrdersAfterCancel,
  refreshOpenOrdersAfterCreate,
} from '../lib/refreshOpenOrders';
import type {
  CreateOrderPayload,
  HoldingItem,
  Order,
  OrderSubmitOptions,
  OrderSubmitResult,
  TradeSnapshotState,
} from '../types';

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

// 향후 Symbol별 trade 상태(holding, openOrders, sellable 등)를 관리할 커스텀 훅의 시작점
export interface SymbolTradingOptions {
  symbol?: string;
  accountSeq?: string;
}

export function useSymbolTrading(
  options: SymbolTradingOptions & {
    setBuyingPower?: (value?: number) => void;
  } = {}
) {
  const { symbol, accountSeq, setBuyingPower } = options;

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
    async (baseline: TradeSnapshotState) => {
      if (!accountSeq || !symbol) return;
      const state = await fetchTradeSnapshotWithRetry(symbol, accountSeq, baseline);
      applyTradeSnapshot(state);
      return state;
    },
    [accountSeq, symbol, applyTradeSnapshot]
  );

  const cancelOrder = useCallback(
    async (orderId: string) => {
      if (!accountSeq) return;
      await api.cancelOrder(orderId, accountSeq);
    },
    [accountSeq]
  );

  // 포트폴리오 리프레시 함수들 (이제 훅 내부에서 set* 호출)
  const refreshPortfolioHoldings = useCallback(async () => {
    if (!accountSeq) return;

    const snapshot = unwrapResult(await api.getPortfolioSnapshot(accountSeq));
    const mapped = mapHoldings(snapshot.holdings);

    if (setBuyingPower) setBuyingPower(toNumber(snapshot.buyingPower.cashBuyingPower));
    setPortfolioHoldings(mapped);
    // savePortfolioHoldings(accountSeq, mapped); // 필요시 외부에서
  }, [accountSeq, setBuyingPower]);

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

  const refreshBuyingPower = useCallback(
    async (accSeq: string) => {
      const buyingPowerRes = await api.getBuyingPower(accSeq).catch(() => null);
      if (buyingPowerRes && setBuyingPower) {
        setBuyingPower(toNumber(unwrapResult(buyingPowerRes).cashBuyingPower));
      }
    },
    [setBuyingPower]
  );

  // 전체 주문 제출 (create + trade refresh + optional take profit)
  // 3개 이상 side effect 콜백은 object payload로 (컨벤션)
  const submitOrder = useCallback(
    async (
      payload: CreateOrderPayload,
      options?: OrderSubmitOptions,
      sideEffects?: {
        refreshMarketNow?: () => void;
        refreshCandlesNow?: () => void;
        refreshBuyingPower?: (acc: string) => Promise<void>;
        refreshPortfolioHoldings?: () => Promise<void>;
        refreshPortfolioOpenOrders?: (acc?: string) => Promise<void>;
      }
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

      sideEffects?.refreshMarketNow?.();
      sideEffects?.refreshCandlesNow?.();

      let st = await refreshTradeAfterOrder(tradeBase);
      if (sideEffects?.refreshBuyingPower) await sideEffects.refreshBuyingPower(acc);
      if (sideEffects?.refreshPortfolioHoldings) await sideEffects.refreshPortfolioHoldings();

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
          if (sideEffects?.refreshBuyingPower) await sideEffects.refreshBuyingPower(acc);
          if (sideEffects?.refreshPortfolioHoldings) await sideEffects.refreshPortfolioHoldings();
          await refreshOpenOrdersAfterCreateForAccount({
            accountSeq: acc,
            baselineSignature: before,
            createdOrderId: tp.orderId,
            orderType: 'LIMIT',
          });
        }
      }

      if (sideEffects?.refreshPortfolioOpenOrders)
        await sideEffects.refreshPortfolioOpenOrders(acc);

      return { takeProfitSell: tp };
    },
    [
      accountSeq,
      getCurrentTradeSnapshot,
      refreshTradeAfterOrder,
      executePostBuyTakeProfit,
      getCachedOpenOrders,
      refreshTrade,
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
  };
}

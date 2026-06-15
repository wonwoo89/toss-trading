import { useCallback } from 'react';
import { useSymbolTrading } from './useSymbolTrading';
import { useRequireAccountSeq } from '../../app/providers/AppContext';
import {
  selectHoldingBySymbol,
  selectOpenOrdersBySymbol,
  formatHoldingValue,
  computePortfolioSummary,
  type Position,
} from '../../entities/position';
import type { CreateOrderPayload, OrderSubmitOptions, OrderSubmitResult } from '../../shared/types';

interface UseTradingOptions {
  symbol?: string;
  accountSeq?: string;
  setBuyingPower?: (value?: number) => void;
  setTotalMarketValue?: (value?: number) => void;
}

export function useTrading(options: UseTradingOptions = {}) {
  const { symbol, accountSeq, setBuyingPower, setTotalMarketValue } = options;

  const data = useSymbolTrading({
    symbol,
    accountSeq,
    setBuyingPower,
    setTotalMarketValue,
  });

  const requireAccountSeq = useRequireAccountSeq();

  // Feature 전용 thin actions (require + 로직 캡슐화) — useCallback for stability (convention)
  const createOrder = useCallback(
    (payload: CreateOrderPayload, opts?: OrderSubmitOptions): Promise<OrderSubmitResult> => {
      requireAccountSeq();
      return data.submitOrder(payload, opts);
    },
    [requireAccountSeq, data.submitOrder]
  );

  const cancelOrder = useCallback(
    async (orderId: string) => {
      requireAccountSeq();
      await data.cancelOrder(orderId);
    },
    [requireAccountSeq, data.cancelOrder]
  );

  // Feature가 제공하는 public API (page는 이걸 통해서만 trading 관련 데이터를 받는다)
  return {
    // UI용 bags
    marketPanelProps: data.marketPanelProps,
    orderFormProps: data.orderFormProps,

    // actions (feature에서 require 처리)
    createOrder,
    cancelOrder,

    // Sidebar용 포트폴리오 데이터 (raw)
    portfolioHoldings: data.portfolioHoldings,
    visibleHoldings: data.visibleHoldings,
    hiddenHoldings: data.hiddenHoldings,
    hiddenSymbols: data.hiddenSymbols,
    toggleHiddenSymbol: data.toggleHiddenSymbol,
    portfolioOpenOrders: data.portfolioOpenOrders,
    portfolioTotals: data.portfolioTotals,
    holdingsRefreshing: data.holdingsRefreshing,

    // Entity를 활용한 position (feature + entity 협력)
    position: {
      holding: selectHoldingBySymbol(data.portfolioHoldings, symbol),
      openOrders: selectOpenOrdersBySymbol(data.portfolioOpenOrders, symbol),
      hasPosition: !!selectHoldingBySymbol(data.portfolioHoldings, symbol)?.quantity,
      formattedValue: formatHoldingValue(
        selectHoldingBySymbol(data.portfolioHoldings, symbol),
        data.marketPanelProps?.currentPrice
      ),
    } satisfies Position,

    // Sidebar-friendly summary using entity (raw lists still available for full lists)
    portfolioSummary: computePortfolioSummary(data.portfolioHoldings),

    // (추가 노출 최소화 — page는 bags와 enriched로 충분)
  };
}

export type { UseTradingOptions };

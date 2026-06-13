import { useSymbolTrading } from '../../shared/hooks/useSymbolTrading';
import { useRequireAccountSeq } from '../../app/providers/AppContext';
import { selectHoldingBySymbol, selectOpenOrdersBySymbol } from '../../entities/position';
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

  // Feature 전용 thin actions (require + 로직 캡슐화)
  const createOrder = (
    payload: CreateOrderPayload,
    opts?: OrderSubmitOptions
  ): Promise<OrderSubmitResult> => {
    requireAccountSeq();
    return data.submitOrder(payload, opts);
  };

  const cancelOrder = async (orderId: string) => {
    requireAccountSeq();
    await data.cancelOrder(orderId);
  };

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
    portfolioOpenOrders: data.portfolioOpenOrders,
    portfolioTotals: data.portfolioTotals,

    // Entity selectors 를 사용한 enriched position data (feature + entity 협력)
    currentHolding: selectHoldingBySymbol(data.portfolioHoldings, symbol),
    currentOpenOrders: selectOpenOrdersBySymbol(data.portfolioOpenOrders, symbol),

    // 필요한 경우 추가 노출 (현재는 최소화)
    refreshPortfolioHoldings: data.refreshPortfolioHoldings,
  };
}

export type { UseTradingOptions };

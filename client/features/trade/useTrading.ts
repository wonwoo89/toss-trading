import { useSymbolTrading } from '../../shared/hooks/useSymbolTrading';
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

  // Feature가 제공하는 public API (page는 이걸 통해서만 trading 관련 데이터를 받는다)
  return {
    // UI용 bags
    marketPanelProps: data.marketPanelProps,
    orderFormProps: data.orderFormProps,

    // actions (require + 로직은 훅 내부에서 처리)
    createOrder: data.createOrder,
    cancelOrder: data.cancelOrder,

    // Sidebar용 포트폴리오 데이터
    portfolioHoldings: data.portfolioHoldings,
    portfolioOpenOrders: data.portfolioOpenOrders,
    portfolioTotals: data.portfolioTotals,

    // 필요한 경우 추가 노출 (현재는 최소화)
    refreshPortfolioHoldings: data.refreshPortfolioHoldings,
  };
}

export type { UseTradingOptions };

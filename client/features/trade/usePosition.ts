import { useTrading } from './useTrading';
import { selectHoldingBySymbol, selectOpenOrdersBySymbol } from '../../entities/position';

interface UsePositionOptions {
  symbol?: string;
}

export function usePosition(options: UsePositionOptions = {}) {
  const { symbol } = options;

  const { portfolioHoldings, portfolioOpenOrders } = useTrading({ symbol });

  const holding = selectHoldingBySymbol(portfolioHoldings, symbol);
  const openOrders = selectOpenOrdersBySymbol(portfolioOpenOrders, symbol);

  return {
    holding,
    openOrdersForSymbol: openOrders,
    hasPosition: !!holding && holding.quantity > 0,
  };
}

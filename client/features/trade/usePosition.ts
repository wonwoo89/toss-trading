import { useTrading } from './useTrading';
import {
  selectHoldingBySymbol,
  selectOpenOrdersBySymbol,
  formatHoldingValue,
  type Position,
} from '../../entities/position';

interface UsePositionOptions {
  symbol?: string;
}

export function usePosition(options: UsePositionOptions = {}): Position {
  const { symbol } = options;

  const { portfolioHoldings, portfolioOpenOrders } = useTrading({ symbol });

  const holding = selectHoldingBySymbol(portfolioHoldings, symbol);
  const openOrders = selectOpenOrdersBySymbol(portfolioOpenOrders, symbol);

  return {
    holding,
    openOrders,
    hasPosition: !!holding && holding.quantity > 0,
    formattedValue: formatHoldingValue(holding),
  } satisfies Position;
}

// trade feature barrel (FSD)
// 향후 order submission, take-profit, trade actions 등을 이 슬라이스로 이동

// Trading feature public API (FSD)
export { useTrading } from './useTrading';
export type { UseTradingOptions } from './useTrading';

export { useTradeActions } from './useTradeActions';
export { usePosition } from './usePosition';
export { useFocusOnSymbol } from './useFocusOnSymbol';

// Feature constants (core hook에서 제공)
export { HOLDINGS_POLL_MS } from './useSymbolTrading';

// Position entity selectors and formatters + domain mappers/ops (entities/position 과 협력, FSD model centralization)
export {
  selectHoldingBySymbol,
  selectOpenOrdersBySymbol,
  formatHoldingValue,
  formatPositionSummary,
  computePortfolioSummary,
  formatProfitLoss,
  formatSignedPercent,
  formatSignedUsd,
  mapHoldingItem,
  mapHoldings,
  mapOrders,
  findHoldingBySymbol,
  sortHoldingsByMarketValue,
  resolveLiveProfitLoss,
  type Position,
} from '../../entities/position';

// (향후: 추가 feature 훅 (useOrderSubmission 등) 로직 이동)

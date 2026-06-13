// trade feature barrel (FSD)
// 향후 order submission, take-profit, trade actions 등을 이 슬라이스로 이동

// Trading feature public API (FSD)
export { useTrading } from './useTrading';
export type { UseTradingOptions } from './useTrading';
export type { Position } from '../../entities/position';

export { useTradeActions } from './useTradeActions';
export { usePosition } from './usePosition';
export { useFocusOnSymbol } from './useFocusOnSymbol';

// Feature constants (core hook에서 제공)
export { HOLDINGS_POLL_MS } from './useSymbolTrading';

// Position entity selectors and formatters (entities/position 과 협력)
export {
  selectHoldingBySymbol,
  selectOpenOrdersBySymbol,
  formatHoldingValue,
  formatPositionSummary,
  computePortfolioSummary,
  type Position,
} from '../../entities/position';

// TODO: 추가 feature 훅 (useOrderSubmission 등) 및 로직 이동

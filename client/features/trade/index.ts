// trade feature barrel (FSD)
// 향후 order submission, take-profit, trade actions 등을 이 슬라이스로 이동

// Trading feature public API (FSD)
export { useTrading } from './useTrading';
export type { UseTradingOptions } from './useTrading';

export { useTradeActions } from './useTradeActions';
export { usePosition } from './usePosition';

// 임시: 하위 호환용 constants (추후 feature 내부로 이동)
export { HOLDINGS_POLL_MS } from './useSymbolTrading';

// Position entity selectors (entities/position 과 협력)
export { selectHoldingBySymbol, selectOpenOrdersBySymbol } from '../../entities/position';

// TODO: useOrderSubmission 등 추가 feature 훅 이동
// TODO: useSymbolTrading 자체를 이 feature로 이동 고려 중

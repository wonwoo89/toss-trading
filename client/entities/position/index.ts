// Position entity (FSD)
// 포트폴리오 holdings / openOrders 관련

export type { HoldingItem, Order } from '../../shared/types';

// 간단한 selector (추후 확장)
export function selectHoldingBySymbol(holdings: HoldingItem[], symbol?: string) {
  if (!symbol) return undefined;
  return holdings.find((h) => h.symbol?.toUpperCase() === symbol.toUpperCase());
}

export function selectOpenOrdersBySymbol(openOrders: Order[], symbol?: string) {
  if (!symbol) return [];
  return openOrders.filter((o) => o.symbol?.toUpperCase() === symbol.toUpperCase());
}

// TODO: mapPortfolio, formatHoldings 등 formatting 로직 이동
// TODO: buildPortfolioSummary 등 더 많은 selector

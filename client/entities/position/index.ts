// Position entity (FSD)
// 포트폴리오 holdings / openOrders 관련

export type { HoldingItem, Order } from '../../shared/types';

// Selectors
export function selectHoldingBySymbol(holdings: HoldingItem[], symbol?: string) {
  if (!symbol) return undefined;
  return holdings.find((h) => h.symbol?.toUpperCase() === symbol.toUpperCase());
}

export function selectOpenOrdersBySymbol(openOrders: Order[], symbol?: string) {
  if (!symbol) return [];
  return openOrders.filter((o) => o.symbol?.toUpperCase() === symbol.toUpperCase());
}

// Basic formatters (moved/added for entity ownership)
export function formatHoldingValue(holding: HoldingItem | undefined, currentPrice?: number): string {
  if (!holding || holding.quantity <= 0) return '—';
  const price = currentPrice ?? holding.marketValue ?? holding.averagePrice ?? 0;
  const value = holding.quantity * price;
  return `$${value.toFixed(2)}`;
}

export function formatPositionSummary(holdings: HoldingItem[]): {
  totalQuantity: number;
  totalValue: number;
  count: number;
} {
  const active = holdings.filter((h) => h.quantity > 0);
  const totalQuantity = active.reduce((sum, h) => sum + h.quantity, 0);
  const totalValue = active.reduce((sum, h) => sum + (h.marketValue ?? h.quantity * (h.averagePrice ?? 0)), 0);
  return {
    totalQuantity,
    totalValue,
    count: active.length,
  };
}

// TODO: more from mapPortfolio, formatHoldings etc.

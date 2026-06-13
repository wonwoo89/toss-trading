// Position entity (FSD)
// 포트폴리오 holdings / openOrders 관련

import type { HoldingItem, Order } from '../../shared/types';

export type { HoldingItem, Order };

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
export function formatHoldingValue(
  holding: HoldingItem | undefined,
  currentPrice?: number
): string {
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
  const totalValue = active.reduce(
    (sum, h) => sum + (h.marketValue ?? h.quantity * (h.averagePrice ?? 0)),
    0
  );
  return {
    totalQuantity,
    totalValue,
    count: active.length,
  };
}

// Simple Position type for the feature
export interface Position {
  holding?: HoldingItem;
  openOrders: Order[];
  hasPosition: boolean;
  formattedValue: string;
}

// Basic portfolio summary using entity logic (for feature to use)
export function computePortfolioSummary(holdings: HoldingItem[]) {
  const summary = formatPositionSummary(holdings);
  const totalProfitLoss = holdings.reduce((sum, h) => sum + (h.profitLoss ?? 0), 0);
  const totalProfitLossRate =
    summary.totalValue > 0 ? totalProfitLoss / summary.totalValue : undefined;
  return {
    ...summary,
    totalProfitLoss,
    totalProfitLossRate,
  };
}

// Re-export position-related formatters from shared/lib for entity ownership (FSD)
export {
  formatProfitLoss,
  formatSignedPercent,
  formatSignedUsd,
} from '../../shared/lib/formatHoldings';

// Domain mappers (adapters from raw kept in shared/lib; re-exported here for FSD entity ownership)
export {
  mapHoldingItem,
  mapHoldings,
  mapOrders,
  findHoldingBySymbol,
} from '../../shared/lib/mapPortfolio';

// Pure domain operations on HoldingItem/Order (source moved here for entity ownership)
export function resolveLiveProfitLoss(
  holding: HoldingItem,
  liveMarketValue: number
): { profitLoss?: number; profitLossRate?: number } {
  const purchaseAmount = holding.purchaseAmount;
  if (purchaseAmount === undefined) {
    return {
      profitLoss: holding.profitLoss,
      profitLossRate: holding.profitLossRate,
    };
  }

  const apiMarketValue = holding.marketValue;
  const apiAfterCostProfit = holding.profitLoss;

  if (apiMarketValue === undefined || apiAfterCostProfit === undefined) {
    const grossProfit = liveMarketValue - purchaseAmount;
    return {
      profitLoss: grossProfit,
      profitLossRate: purchaseAmount !== 0 ? grossProfit / purchaseAmount : undefined,
    };
  }

  const grossProfitAtApi = apiMarketValue - purchaseAmount;
  const costDeduction = grossProfitAtApi - apiAfterCostProfit;
  const profitLoss = liveMarketValue - purchaseAmount - costDeduction;
  const profitLossRate = purchaseAmount !== 0 ? profitLoss / purchaseAmount : undefined;

  return { profitLoss, profitLossRate };
}

export function sortHoldingsByMarketValue(holdings: HoldingItem[]): HoldingItem[] {
  return [...holdings].sort((a, b) => {
    const marketValueDiff = (b.marketValue ?? 0) - (a.marketValue ?? 0);
    if (marketValueDiff !== 0) return marketValueDiff;
    return a.symbol.localeCompare(b.symbol);
  });
}

// 추가 포맷/셀렉터는 formatHoldings 등에서 점진 re-export 또는 entity 내 확장

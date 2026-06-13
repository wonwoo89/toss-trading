import { sortHoldingsByMarketValue } from './mapPortfolio';
import type { HoldingItem, Order } from '../types';

interface PortfolioSnapshot {
  holdings: HoldingItem[];
  openOrders: Order[];
}

const cache = new Map<string, PortfolioSnapshot>();

function getOrCreate(accountSeq: string): PortfolioSnapshot {
  const existing = cache.get(accountSeq);
  if (existing) return existing;

  const snapshot: PortfolioSnapshot = { holdings: [], openOrders: [] };
  cache.set(accountSeq, snapshot);
  return snapshot;
}

export function getPortfolioCache(accountSeq: string): PortfolioSnapshot | undefined {
  return cache.get(accountSeq);
}

export function setPortfolioHoldings(accountSeq: string, holdings: HoldingItem[]) {
  const snapshot = getOrCreate(accountSeq);
  snapshot.holdings = sortHoldingsByMarketValue(holdings);
}

export function setPortfolioOpenOrders(accountSeq: string, openOrders: Order[]) {
  const snapshot = getOrCreate(accountSeq);
  snapshot.openOrders = openOrders;
}

export function upsertPortfolioHolding(accountSeq: string, holding: HoldingItem) {
  const snapshot = getOrCreate(accountSeq);
  const symbol = holding.symbol.toUpperCase();
  const index = snapshot.holdings.findIndex((item) => item.symbol.toUpperCase() === symbol);

  if (holding.quantity <= 0) {
    if (index >= 0) {
      snapshot.holdings.splice(index, 1);
    }
    return;
  }

  if (index >= 0) {
    snapshot.holdings[index] = holding;
  } else {
    snapshot.holdings.push(holding);
  }

  snapshot.holdings = sortHoldingsByMarketValue(snapshot.holdings);
}

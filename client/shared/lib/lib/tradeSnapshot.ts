import { api } from '../../shared/api/client';
import { mapHoldingItem, mapOrders } from './mapPortfolio';
import { toNumber, unwrapResult } from './parse';
import type { HoldingItem, Order } from '../types';

export interface TradeSnapshotState {
  holding?: HoldingItem;
  sellableQuantity?: number;
  openOrders: Order[];
}

function getOpenOrderSignature(orders: Order[]) {
  return orders
    .map((order) => order.orderId)
    .sort()
    .join(',');
}

export async function fetchTradeSnapshotState(
  symbol: string,
  accountSeq: string
): Promise<TradeSnapshotState> {
  const snapshot = unwrapResult(await api.getTradeSnapshot(symbol, accountSeq));

  return {
    sellableQuantity: snapshot.sellableQuantity
      ? toNumber(snapshot.sellableQuantity.sellableQuantity)
      : undefined,
    holding: snapshot.holding ? mapHoldingItem(snapshot.holding) : undefined,
    openOrders: mapOrders(snapshot.orders),
  };
}

export function hasTradeSnapshotChanged(
  previous: TradeSnapshotState,
  next: TradeSnapshotState
): boolean {
  const prevQuantity = previous.holding?.quantity ?? 0;
  const nextQuantity = next.holding?.quantity ?? 0;
  const prevAverage = previous.holding?.averagePrice;
  const nextAverage = next.holding?.averagePrice;
  const prevSellable = previous.sellableQuantity;
  const nextSellable = next.sellableQuantity;
  const prevOrders = getOpenOrderSignature(previous.openOrders);
  const nextOrders = getOpenOrderSignature(next.openOrders);

  return (
    prevQuantity !== nextQuantity ||
    prevAverage !== nextAverage ||
    prevSellable !== nextSellable ||
    prevOrders !== nextOrders
  );
}

const POST_ORDER_REFRESH_DELAYS_MS = [0, 800, 1600, 3200, 5000] as const;

export async function fetchTradeSnapshotWithRetry(
  symbol: string,
  accountSeq: string,
  baseline: TradeSnapshotState
): Promise<TradeSnapshotState> {
  let latest = baseline;

  for (const delayMs of POST_ORDER_REFRESH_DELAYS_MS) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    latest = await fetchTradeSnapshotState(symbol, accountSeq);
    if (hasTradeSnapshotChanged(baseline, latest)) {
      break;
    }
  }

  return latest;
}

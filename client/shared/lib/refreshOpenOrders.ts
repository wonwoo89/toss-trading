import type { Order } from '../types';

const OPEN_ORDERS_REFRESH_DELAYS_MS = [0, 400, 900, 1800, 3000, 5000] as const;

export function getOpenOrdersSignature(orders: Order[]) {
  return orders
    .map((order) => order.orderId)
    .sort()
    .join(',');
}

async function refreshWithRetry(
  refresh: () => Promise<void>,
  isDone: (attempt: number) => boolean
) {
  for (let attempt = 0; attempt < OPEN_ORDERS_REFRESH_DELAYS_MS.length; attempt++) {
    const delayMs = OPEN_ORDERS_REFRESH_DELAYS_MS[attempt];
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    await refresh();
    if (isDone(attempt)) return;
  }

  await refresh();
}

export async function refreshOpenOrdersAfterCreate(
  refresh: () => Promise<void>,
  getOrders: () => Order[],
  baselineSignature: string,
  createdOrderId?: string,
  orderType: 'LIMIT' | 'MARKET' = 'LIMIT'
) {
  let sawCreatedOrder = false;

  await refreshWithRetry(refresh, (attempt) => {
    const orders = getOrders();
    const signature = getOpenOrdersSignature(orders);

    if (createdOrderId) {
      const isPresent = orders.some((order) => order.orderId === createdOrderId);
      if (isPresent) {
        sawCreatedOrder = true;
        if (orderType === 'LIMIT') return true;
      }

      if (!isPresent && orderType === 'MARKET') return true;
      if (!isPresent && sawCreatedOrder) return true;
      if (!isPresent && orderType === 'LIMIT' && attempt >= 2) return true;
    }

    return signature !== baselineSignature;
  });
}

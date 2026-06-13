import { ORDER_SIDE_LABEL, ORDER_TYPE_LABEL } from './labels';
import type { Order } from '../types';
import type { MicrostructureBias } from './marketMicrostructure';

export interface MarketMetric {
  id: string;
  label: string;
  value: string;
  bias: MicrostructureBias;
}

function formatOrderTime(orderedAt?: string) {
  if (!orderedAt) return '—';
  return new Date(orderedAt).toLocaleString('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function buildRecentOrderActivityMetric(
  openOrders: Order[],
  closedOrders: Order[],
  closedOrdersUnavailable?: boolean
): MarketMetric {
  const filledOpenOrders = openOrders
    .filter((order) => (order.filledQuantity ?? 0) > 0)
    .sort((a, b) => {
      const aTime = a.orderedAt ? new Date(a.orderedAt).getTime() : 0;
      const bTime = b.orderedAt ? new Date(b.orderedAt).getTime() : 0;
      return bTime - aTime;
    });

  const recentClosed = closedOrders
    .slice()
    .sort((a, b) => {
      const aTime = a.orderedAt ? new Date(a.orderedAt).getTime() : 0;
      const bTime = b.orderedAt ? new Date(b.orderedAt).getTime() : 0;
      return bTime - aTime;
    })
    .slice(0, 3);

  const source = recentClosed.length > 0 ? recentClosed : filledOpenOrders.slice(0, 3);

  if (source.length === 0) {
    return {
      id: 'order-history',
      label: '최근 체결',
      value: closedOrdersUnavailable ? '종료 주문 API 미지원' : '최근 체결 없음',
      bias: 'neutral',
    };
  }

  const latest = source[0];
  const sideLabel = ORDER_SIDE_LABEL[latest.side];
  const typeLabel = ORDER_TYPE_LABEL[latest.orderType];
  const qty = latest.filledQuantity ?? latest.quantity;
  const priceText = latest.price !== undefined ? latest.price.toFixed(2) : '시장가';

  const summary = `${formatOrderTime(latest.orderedAt)} ${sideLabel} ${qty}주 @ ${priceText}`;
  const extra = source.length > 1 ? ` 외 ${source.length - 1}건` : '';

  return {
    id: 'order-history',
    label: '최근 체결',
    value: `${summary}${extra} (${typeLabel})`,
    bias: latest.side === 'BUY' ? 'bullish' : 'bearish',
  };
}

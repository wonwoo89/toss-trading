import { formatUsd } from './formatHoldings';
import { ORDER_SIDE_LABEL, ORDER_TYPE_LABEL } from './labels';
import type { CreateOrderPayload } from '../types';

function formatQuantity(quantity: number) {
  const rounded = Math.round(quantity * 10000) / 10000;
  return rounded.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

export function formatOrderSuccessMessage(payload: CreateOrderPayload) {
  const sideLabel = ORDER_SIDE_LABEL[payload.side];
  const typeLabel = ORDER_TYPE_LABEL[payload.orderType];

  if (payload.orderAmount !== undefined) {
    return `${payload.symbol} ${formatUsd(payload.orderAmount)} ${typeLabel} ${sideLabel} 주문이 접수되었습니다.`;
  }

  const quantityLabel = `${formatQuantity(payload.quantity ?? 0)}주`;

  if (payload.orderType === 'MARKET') {
    return `${payload.symbol} ${quantityLabel} ${typeLabel} ${sideLabel} 주문이 접수되었습니다.`;
  }

  const priceLabel =
    payload.price !== undefined
      ? `$${payload.price.toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 4,
        })}`
      : '—';

  return `${payload.symbol} ${quantityLabel} ${priceLabel} ${typeLabel} ${sideLabel} 주문이 접수되었습니다.`;
}

import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  formatOpenOrderStatus,
  formatOrderDateLabel,
  formatOrderPriceLabel,
  sortOrdersByDate,
} from '../lib/formatOrders';
import type { Order } from '../types';

interface OpenOrdersPanelProps {
  openOrders: Order[];
  onCancel: (orderId: string) => Promise<void>;
  hideSymbol?: boolean;
}

export function OpenOrdersPanel({
  openOrders,
  onCancel,
  hideSymbol = false,
}: OpenOrdersPanelProps) {
  const [cancellingOrderId, setCancellingOrderId] = useState<string | null>(null);

  const handleCancel = async (orderId: string) => {
    setCancellingOrderId(orderId);
    try {
      await onCancel(orderId);
    } finally {
      setCancellingOrderId(null);
    }
  };

  const sortedOrders = sortOrdersByDate(openOrders);

  return (
    <section className="panel open-orders-panel">
      <div className="panel-title open-orders-panel__title">
        <h2>미체결 주문</h2>
      </div>

      <div className="panel-body open-orders-panel__body">
        {openOrders.length === 0 ? (
          <p className="hint open-orders-panel__empty">미체결 주문이 없습니다.</p>
        ) : (
          <ul className="order-history-list">
            {sortedOrders.map((order) => {
              const dateLabel = formatOrderDateLabel(order.orderedAt);
              const leftLabel = hideSymbol ? dateLabel : `${dateLabel} ${order.symbol}`;
              const isCancelling = cancellingOrderId === order.orderId;

              return (
                <li key={order.orderId} className="order-history-item">
                  <div className="order-history-item__content">
                    {hideSymbol ? (
                      <span className="order-history-item__date-symbol">{leftLabel}</span>
                    ) : (
                      <Link
                        to={`/stock/${order.symbol}`}
                        className="order-history-item__date-symbol symbol-link"
                      >
                        {leftLabel}
                      </Link>
                    )}

                    <div className="order-history-item__summary">
                      <span className="order-history-item__price">
                        {formatOrderPriceLabel(order)}
                      </span>
                      <div className="order-history-item__status-row">
                        <span
                          className={`order-history-item__status${order.side === 'BUY' ? ' is-buy' : ' is-sell'}`}
                        >
                          {formatOpenOrderStatus(order)}
                        </span>
                        <button
                          type="button"
                          className="order-history-item__cancel"
                          onClick={() => void handleCancel(order.orderId)}
                          disabled={isCancelling}
                        >
                          {isCancelling ? '취소 중…' : '취소'}
                        </button>
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

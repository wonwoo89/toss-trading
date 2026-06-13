import { useCallback } from 'react';

import { useRequireAccountSeq } from '../../app/providers/AppContext';
import { useSymbolTrading } from './useSymbolTrading';
import type { CreateOrderPayload, OrderSubmitOptions, OrderSubmitResult } from '../../shared/types';

interface UseTradeActionsOptions {
  symbol?: string;
  accountSeq?: string;
}

export function useTradeActions(options: UseTradeActionsOptions = {}) {
  const requireAccountSeq = useRequireAccountSeq();
  const { submitOrder, cancelOrder: rawCancelOrder } = useSymbolTrading(options);

  const createOrder = useCallback(
    async (payload: CreateOrderPayload, opts?: OrderSubmitOptions): Promise<OrderSubmitResult> => {
      requireAccountSeq();
      return submitOrder(payload, opts);
    },
    [requireAccountSeq, submitOrder]
  );

  const cancelOrder = useCallback(
    async (orderId: string) => {
      requireAccountSeq();
      await rawCancelOrder(orderId);
    },
    [requireAccountSeq, rawCancelOrder]
  );

  return {
    createOrder,
    cancelOrder,
  };
}

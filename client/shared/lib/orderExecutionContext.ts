import { formatUsd } from './formatHoldings';
import type { MicrostructureBias } from './marketMicrostructure';
import type { Order } from '../types';

export interface MarketMetric {
  id: string;
  label: string;
  value: string;
  bias: MicrostructureBias;
}

function getMaxBuyQuantity(buyingPower: number, unitPrice: number) {
  if (unitPrice <= 0) return 0;
  return Math.floor(buyingPower / unitPrice);
}

function formatOrderPrice(price?: number) {
  if (price === undefined) return '시장가';
  return formatUsd(price);
}

export function buildOrderExecutionMetrics(params: {
  openOrders: Order[];
  buyingPower?: number;
  sellableQuantity?: number;
  holdingQuantity?: number;
  currentPrice?: number;
}): MarketMetric[] {
  const { openOrders, buyingPower, sellableQuantity, holdingQuantity, currentPrice } = params;
  const symbolOrders = openOrders;

  console.log(`[client] buildOrderExecutionMetrics: buyingPower=${buyingPower}, currentPrice=${currentPrice}, hasSell=${(sellableQuantity ?? holdingQuantity) != null}`);

  const buyOrders = symbolOrders.filter((order) => order.side === 'BUY');
  const sellOrders = symbolOrders.filter((order) => order.side === 'SELL');

  const openOrderSummary =
    symbolOrders.length === 0 ? '없음' : `매수 ${buyOrders.length} · 매도 ${sellOrders.length}`;

  const nearestBuy = buyOrders
    .filter((order) => order.price !== undefined)
    .sort((a, b) => (b.price ?? 0) - (a.price ?? 0))[0];
  const nearestSell = sellOrders
    .filter((order) => order.price !== undefined)
    .sort((a, b) => (a.price ?? 0) - (b.price ?? 0))[0];

  let openOrderDetail = openOrderSummary;
  if (nearestBuy || nearestSell) {
    const parts = [
      nearestBuy ? `매수 ${formatOrderPrice(nearestBuy.price)}` : undefined,
      nearestSell ? `매도 ${formatOrderPrice(nearestSell.price)}` : undefined,
    ].filter(Boolean);
    openOrderDetail = `${openOrderSummary} (${parts.join(' / ')})`;
  }

  // "불러오는 중" 은 실제 async fetch가 진행 중일 때만.
  // buyingPower(계좌 글로벌) 또는 currentPrice(종목별 market snapshot) 중 하나라도 도착하면
  // loading 상태를 벗어나서, 계산 가능하면 숫자, 아니면 '—' 로 settle.
  // 이렇게 해야 symbol 변경 후 "불러오는 중" 에서 영원히 안 넘어가는 문제를 피함.
  const hasBuyInputs = buyingPower !== undefined && currentPrice !== undefined && currentPrice > 0;
  const maxBuyQuantity =
    hasBuyInputs ? getMaxBuyQuantity(buyingPower, currentPrice) : undefined;

  let buyCapacity: string;
  if (hasBuyInputs) {
    buyCapacity = maxBuyQuantity !== undefined
      ? `${maxBuyQuantity.toLocaleString()}주 (${formatUsd(buyingPower)})`
      : '—';
  } else if (buyingPower !== undefined || currentPrice !== undefined) {
    // 일부 데이터는 왔지만 price가 없거나 0이거나 buyingPower 아직 undefined → 가격 정보 부족
    buyCapacity = '—';
  } else {
    buyCapacity = '불러오는 중';
  }

  const effectiveSellable = sellableQuantity ?? holdingQuantity ?? undefined;
  const hasSellInputs = effectiveSellable !== undefined;
  const sellCapacity = hasSellInputs ? `${effectiveSellable.toLocaleString()}주` : '불러오는 중';

  return [
    {
      id: 'open-orders',
      label: '미체결',
      value: openOrderDetail,
      bias: symbolOrders.length > 0 ? 'neutral' : 'neutral',
    },
    {
      id: 'buy-capacity',
      label: '매수 가능',
      value: buyCapacity,
      bias: maxBuyQuantity !== undefined && maxBuyQuantity > 0 ? 'bullish' : 'neutral',
    },
    {
      id: 'sell-capacity',
      label: '매도 가능',
      value: sellCapacity,
      bias: effectiveSellable !== undefined && effectiveSellable > 0 ? 'bearish' : 'neutral',
    },
  ];
}

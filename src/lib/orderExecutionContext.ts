import { formatUsd } from './formatHoldings'
import type { MicrostructureBias } from './marketMicrostructure'
import type { Order } from '../types'

export interface MarketMetric {
  id: string
  label: string
  value: string
  bias: MicrostructureBias
}

function getMaxBuyQuantity(buyingPower: number, unitPrice: number) {
  if (unitPrice <= 0) return 0
  return Math.floor(buyingPower / unitPrice)
}

function formatOrderPrice(price?: number) {
  if (price === undefined) return '시장가'
  return formatUsd(price)
}

export function buildOrderExecutionMetrics(params: {
  openOrders: Order[]
  buyingPower?: number
  sellableQuantity?: number
  currentPrice?: number
}): MarketMetric[] {
  const { openOrders, buyingPower, sellableQuantity, currentPrice } = params
  const symbolOrders = openOrders

  const buyOrders = symbolOrders.filter((order) => order.side === 'BUY')
  const sellOrders = symbolOrders.filter((order) => order.side === 'SELL')

  const openOrderSummary =
    symbolOrders.length === 0
      ? '없음'
      : `매수 ${buyOrders.length} · 매도 ${sellOrders.length}`

  const nearestBuy = buyOrders
    .filter((order) => order.price !== undefined)
    .sort((a, b) => (b.price ?? 0) - (a.price ?? 0))[0]
  const nearestSell = sellOrders
    .filter((order) => order.price !== undefined)
    .sort((a, b) => (a.price ?? 0) - (b.price ?? 0))[0]

  let openOrderDetail = openOrderSummary
  if (nearestBuy || nearestSell) {
    const parts = [
      nearestBuy ? `매수 ${formatOrderPrice(nearestBuy.price)}` : undefined,
      nearestSell ? `매도 ${formatOrderPrice(nearestSell.price)}` : undefined,
    ].filter(Boolean)
    openOrderDetail = `${openOrderSummary} (${parts.join(' / ')})`
  }

  const maxBuyQuantity =
    buyingPower !== undefined && currentPrice !== undefined && currentPrice > 0
      ? getMaxBuyQuantity(buyingPower, currentPrice)
      : undefined

  const buyCapacity =
    maxBuyQuantity !== undefined
      ? `${maxBuyQuantity.toLocaleString()}주 (${formatUsd(buyingPower)})`
      : '—'

  const sellCapacity =
    sellableQuantity !== undefined
      ? `${sellableQuantity.toLocaleString()}주`
      : '—'

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
      bias:
        maxBuyQuantity !== undefined && maxBuyQuantity > 0 ? 'bullish' : 'neutral',
    },
    {
      id: 'sell-capacity',
      label: '매도 가능',
      value: sellCapacity,
      bias:
        sellableQuantity !== undefined && sellableQuantity > 0 ? 'bearish' : 'neutral',
    },
  ]
}
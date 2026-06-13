import { ORDER_SIDE_LABEL } from './labels'
import type { Order } from '../types'

const NUMBER_LOCALE = 'en-US'

export function formatOrderDateLabel(orderedAt?: string) {
  const date = orderedAt ? new Date(orderedAt) : new Date()
  if (Number.isNaN(date.getTime())) {
    return '—'
  }

  return `${date.getMonth() + 1}.${date.getDate()}`
}

export function formatOrderPriceLabel(order: Order) {
  if (order.orderType === 'MARKET') return '시장가'
  if (order.price === undefined) return '—'

  return `주당 $${order.price.toLocaleString(NUMBER_LOCALE, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })}`
}

export function formatOpenOrderStatus(order: Order) {
  const quantity = order.quantity ?? order.filledQuantity
  const quantityText =
    quantity === undefined
      ? '—'
      : `${quantity.toLocaleString(NUMBER_LOCALE, { maximumFractionDigits: 4 })}주`

  const sideLabel = ORDER_SIDE_LABEL[order.side]
  return `${quantityText} ${sideLabel} 대기`
}

export function sortOrdersByDate(orders: Order[]) {
  return orders.slice().sort((a, b) => {
    const aTime = a.orderedAt ? new Date(a.orderedAt).getTime() : 0
    const bTime = b.orderedAt ? new Date(b.orderedAt).getTime() : 0
    return bTime - aTime
  })
}
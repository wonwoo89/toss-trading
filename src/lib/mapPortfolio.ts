import { toNumber } from './parse'
import type {
  HoldingItem,
  HoldingsItemRaw,
  HoldingsRaw,
  Order,
  OrdersPageRaw,
} from '../types'

function mapHoldingItemRaw(item: HoldingsItemRaw): HoldingItem {
  const quantity = toNumber(item.quantity) ?? 0
  const averagePrice = toNumber(item.averagePurchasePrice)
  const currentPrice = toNumber(item.lastPrice)
  const purchaseAmount =
    toNumber(item.marketValue?.purchaseAmount) ??
    (averagePrice !== undefined ? quantity * averagePrice : undefined)
  const marketValue =
    toNumber(item.marketValue?.amount) ??
    (currentPrice !== undefined ? quantity * currentPrice : undefined)

  const grossProfitLoss = toNumber(item.profitLoss?.amount)
  const afterCostProfitLoss = toNumber(
    item.profitLoss?.amountAfterCost ?? item.profitLoss?.amount,
  )
  const profitLossCostDrag =
    grossProfitLoss !== undefined && afterCostProfitLoss !== undefined
      ? grossProfitLoss - afterCostProfitLoss
      : undefined

  return {
    symbol: item.symbol,
    name: item.name,
    quantity,
    averagePrice,
    currentPrice,
    purchaseAmount,
    marketValue,
    profitLoss: afterCostProfitLoss,
    profitLossRate: toNumber(item.profitLoss?.rateAfterCost ?? item.profitLoss?.rate),
    grossProfitLoss,
    profitLossCostDrag,
    costCommission: toNumber(item.cost?.commission),
    costTax:
      item.cost?.tax === null || item.cost?.tax === undefined
        ? item.cost?.tax ?? undefined
        : toNumber(item.cost?.tax),
  }
}

export function resolveLiveProfitLoss(
  holding: HoldingItem,
  liveMarketValue: number,
): { profitLoss?: number; profitLossRate?: number } {
  const purchaseAmount = holding.purchaseAmount
  if (purchaseAmount === undefined) {
    return {
      profitLoss: holding.profitLoss,
      profitLossRate: holding.profitLossRate,
    }
  }

  const apiMarketValue = holding.marketValue
  const apiAfterCostProfit = holding.profitLoss

  if (apiMarketValue === undefined || apiAfterCostProfit === undefined) {
    const grossProfit = liveMarketValue - purchaseAmount
    return {
      profitLoss: grossProfit,
      profitLossRate: purchaseAmount !== 0 ? grossProfit / purchaseAmount : undefined,
    }
  }

  const grossProfitAtApi = apiMarketValue - purchaseAmount
  const costDeduction = grossProfitAtApi - apiAfterCostProfit
  const profitLoss = liveMarketValue - purchaseAmount - costDeduction
  const profitLossRate = purchaseAmount !== 0 ? profitLoss / purchaseAmount : undefined

  return { profitLoss, profitLossRate }
}

export function mapHoldingItem(item: HoldingsItemRaw): HoldingItem {
  return mapHoldingItemRaw(item)
}

export function findHoldingBySymbol(
  holdings: HoldingsRaw,
  symbol: string,
): HoldingItem | undefined {
  const item = holdings.items.find(
    (holding) => holding.symbol.toUpperCase() === symbol.toUpperCase(),
  )
  if (!item) return undefined
  return mapHoldingItem(item)
}

export function sortHoldingsByMarketValue(holdings: HoldingItem[]): HoldingItem[] {
  return [...holdings].sort((a, b) => {
    const marketValueDiff = (b.marketValue ?? 0) - (a.marketValue ?? 0)
    if (marketValueDiff !== 0) return marketValueDiff
    return a.symbol.localeCompare(b.symbol)
  })
}

export function mapHoldings(holdings: HoldingsRaw): HoldingItem[] {
  return sortHoldingsByMarketValue(
    holdings.items
      .filter((item) => item.marketCountry === 'US' || item.currency === 'USD')
      .map(mapHoldingItemRaw),
  )
}

export function mapOrders(orders: OrdersPageRaw | null | undefined): Order[] {
  return (orders?.orders ?? []).map((order) => ({
    orderId: order.orderId,
    symbol: order.symbol,
    side: order.side,
    orderType: order.orderType,
    status: order.status,
    quantity: toNumber(order.quantity),
    price: toNumber(order.price),
    filledQuantity: toNumber(order.execution?.filledQuantity),
    orderedAt: order.orderedAt,
  }))
}
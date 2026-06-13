export interface ApiEnvelope<T> {
  result: T
}

export interface ApiError {
  error?: {
    message?: string
    code?: string
    requestId?: string
    data?: unknown
  }
}

export interface Account {
  accountSeq: number
  accountNo: string
  accountName?: string
  accountType?: string
}

export interface StockInfo {
  symbol: string
  name: string
  englishName?: string
  market: string
  currency: string
}

export interface PriceInfo {
  symbol: string
  lastPrice: string
  currency: string
  timestamp?: string | null
}

export interface OrderbookEntryRaw {
  price: string
  volume: string
}

export interface OrderbookRaw {
  bids: OrderbookEntryRaw[]
  asks: OrderbookEntryRaw[]
  currency: string
}

export interface TradeRaw {
  price: string
  volume: string
  timestamp: string
}

export interface StockWarningRaw {
  warningType: string
}

export interface BuyingPowerRaw {
  currency: string
  cashBuyingPower: string
}

export interface HoldingsItemRaw {
  symbol: string
  name: string
  marketCountry: string
  currency: string
  quantity: string
  lastPrice: string
  averagePurchasePrice: string
  marketValue?: {
    purchaseAmount: string
    amount: string
    amountAfterCost?: string
  }
  profitLoss?: {
    amount: string
    amountAfterCost?: string
    rate: string
    rateAfterCost?: string
  }
  cost?: {
    commission: string
    tax?: string | null
  }
}

export interface HoldingsRaw {
  items: HoldingsItemRaw[]
}

export interface OrderRaw {
  orderId: string
  symbol: string
  side: 'BUY' | 'SELL'
  orderType: 'LIMIT' | 'MARKET'
  status: string
  quantity: string
  price?: string
  orderedAt?: string
  execution?: {
    filledQuantity?: string
  }
}

export interface OrdersPageRaw {
  orders: OrderRaw[]
  nextCursor: string | null
  hasNext: boolean
}

export interface SellableQuantityRaw {
  sellableQuantity: string
}

export interface ExchangeRateRaw {
  rate: string
  baseCurrency: string
  quoteCurrency: string
}

export interface CommissionRaw {
  marketCountry: string
  commissionRate: string
  startDate?: string | null
  endDate?: string | null
}

export interface UsMarketSessionRaw {
  startTime: string
  endTime: string
}

export interface UsMarketDayRaw {
  date: string
  dayMarket?: UsMarketSessionRaw | null
  preMarket?: UsMarketSessionRaw | null
  regularMarket?: UsMarketSessionRaw | null
  afterMarket?: UsMarketSessionRaw | null
}

export interface UsMarketCalendarRaw {
  today: UsMarketDayRaw
  previousBusinessDay: UsMarketDayRaw
  nextBusinessDay: UsMarketDayRaw
}

export interface CandleRaw {
  timestamp: string
  openPrice: string
  highPrice: string
  lowPrice: string
  closePrice: string
  volume: string
}

export interface CandlePageRaw {
  candles: CandleRaw[]
  nextBefore: string | null
}

export interface ChartCandle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface HoldingItem {
  symbol: string
  name?: string
  quantity: number
  averagePrice?: number
  currentPrice?: number
  purchaseAmount?: number
  marketValue?: number
  profitLoss?: number
  profitLossRate?: number
  grossProfitLoss?: number
  profitLossCostDrag?: number
  costCommission?: number
  costTax?: number | null
}

export interface OrderCreateResponse {
  orderId: string
  clientOrderId?: string
}

export interface Order {
  orderId: string
  symbol: string
  side: 'BUY' | 'SELL'
  orderType: 'LIMIT' | 'MARKET'
  status: string
  quantity?: number
  price?: number
  filledQuantity?: number
  orderedAt?: string
}

export interface CreateOrderPayload {
  clientOrderId?: string
  symbol: string
  side: 'BUY' | 'SELL'
  orderType: 'LIMIT' | 'MARKET'
  quantity?: number
  orderAmount?: number
  price?: number
  confirmHighValueOrder?: boolean
  timeInForce?: 'DAY' | 'CLS'
}

export interface OrderSubmitOptions {
  takeProfitSell?: {
    profitRatePercent: number
  }
}

export interface OrderSubmitResult {
  takeProfitSell?: {
    placed: boolean
    price?: number
    quantity?: number
    orderId?: string
    message?: string
  }
}

export type CandleInterval = '1m' | '5m' | '10m' | '1d' | '1w' | '1M'

export const CANDLE_INTERVALS: { value: CandleInterval; label: string }[] = [
  { value: '1m', label: '1분' },
  { value: '5m', label: '5분' },
  { value: '10m', label: '10분' },
  { value: '1d', label: '일' },
  { value: '1w', label: '주' },
  { value: '1M', label: '월' },
]
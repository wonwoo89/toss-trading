import { getLatestBollingerBands } from './bollingerBands'
import { buildChartSignalSnapshot } from './chartSignals'
import {
  calculateRoundTripBreakEvenSellPrice,
  resolveUsCommissionRatePercent,
} from './commissionBreakEven'
import { calculateTakeProfitSellPrice, getTakeProfitCostContext } from './takeProfitSell'
import type { CandleInterval, ChartCandle, CommissionRaw, HoldingItem, Order } from '../types'

const SUPPORT_RESISTANCE_PERIOD = 20
const ATR_PERIOD = 14
const MAX_DISTANCE_ATR_RATIO = 0.45

export interface OrderbookLevel {
  price: number
  quantity: number
}

export interface TradeTick {
  price: number
  quantity: number
  timestamp: string
}

export interface LimitPriceRecommendationInput {
  side: 'BUY' | 'SELL'
  currentPrice?: number
  candles?: ChartCandle[]
  candleInterval?: CandleInterval
  bids?: OrderbookLevel[]
  asks?: OrderbookLevel[]
  trades?: TradeTick[]
  holding?: HoldingItem
  targetProfitRatePercent?: number
  commissionRatePercent?: number
  commissions?: CommissionRaw[]
  openOrders?: Order[]
}

export interface LimitPriceRecommendation {
  available: boolean
  price?: number
  priceLabel: string
  summary: string
  reasons: string[]
}

function roundUsd(price: number) {
  return Math.round(price * 100) / 100
}

function getBestBid(bids: OrderbookLevel[]) {
  if (bids.length === 0) return undefined
  return Math.max(...bids.map((bid) => bid.price))
}

function getBestAsk(asks: OrderbookLevel[]) {
  if (asks.length === 0) return undefined
  return Math.min(...asks.map((ask) => ask.price))
}

function getTodayCandles(candles: ChartCandle[], interval: CandleInterval) {
  if (candles.length === 0) return []

  if (interval === '1d' || interval === '1w' || interval === '1M') {
    const last = candles[candles.length - 1]
    return last ? [last] : []
  }

  const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' })
  return candles.filter(
    (candle) =>
      new Date(candle.time * 1000).toLocaleDateString('en-CA', {
        timeZone: 'Asia/Seoul',
      }) === todayKey,
  )
}

function getVwapAndDayRange(candles: ChartCandle[], interval: CandleInterval) {
  const todayCandles = getTodayCandles(candles, interval)
  if (todayCandles.length === 0) {
    return { vwap: undefined, dayHigh: undefined, dayLow: undefined }
  }

  let volumeSum = 0
  let vwapNumerator = 0
  let dayHigh = -Infinity
  let dayLow = Infinity

  for (const candle of todayCandles) {
    const typical = (candle.high + candle.low + candle.close) / 3
    vwapNumerator += typical * candle.volume
    volumeSum += candle.volume
    dayHigh = Math.max(dayHigh, candle.high)
    dayLow = Math.min(dayLow, candle.low)
  }

  return {
    vwap: volumeSum > 0 ? vwapNumerator / volumeSum : undefined,
    dayHigh: Number.isFinite(dayHigh) ? dayHigh : undefined,
    dayLow: Number.isFinite(dayLow) ? dayLow : undefined,
  }
}

function getSupportResistance(candles: ChartCandle[]) {
  const sorted = candles.slice().sort((a, b) => a.time - b.time)
  const recent = sorted.slice(-SUPPORT_RESISTANCE_PERIOD)
  if (recent.length < 5) {
    return { support: undefined, resistance: undefined }
  }

  return {
    support: Math.min(...recent.map((candle) => candle.low)),
    resistance: Math.max(...recent.map((candle) => candle.high)),
  }
}

function calculateAtr(candles: ChartCandle[]) {
  if (candles.length < ATR_PERIOD + 1) return undefined

  const sorted = candles.slice().sort((a, b) => a.time - b.time)
  const trueRanges: number[] = []

  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index]
    const previous = sorted[index - 1]
    trueRanges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close),
      ),
    )
  }

  const recent = trueRanges.slice(-ATR_PERIOD)
  return recent.reduce((sum, value) => sum + value, 0) / recent.length
}

function getTradeFlowBias(trades: TradeTick[], bestBid?: number, bestAsk?: number) {
  if (trades.length === 0) return 0

  const mid =
    bestBid !== undefined && bestAsk !== undefined
      ? (bestBid + bestAsk) / 2
      : undefined

  const sorted = [...trades].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  )

  let buyVolume = 0
  let sellVolume = 0
  let previousPrice: number | undefined
  let previousSide: 'buy' | 'sell' | undefined

  for (const trade of sorted) {
    let side: 'buy' | 'sell' | undefined
    if (previousPrice !== undefined) {
      if (trade.price > previousPrice) side = 'buy'
      else if (trade.price < previousPrice) side = 'sell'
      else side = previousSide
    } else if (mid !== undefined) {
      side = trade.price >= mid ? 'buy' : 'sell'
    }

    if (side === 'buy') {
      buyVolume += trade.quantity
      previousSide = 'buy'
    } else if (side === 'sell') {
      sellVolume += trade.quantity
      previousSide = 'sell'
    }

    previousPrice = trade.price
  }

  const total = buyVolume + sellVolume
  if (total <= 0) return 0
  return buyVolume / total - 0.5
}

function getSignalNudge(candles: ChartCandle[], bids: OrderbookLevel[], asks: OrderbookLevel[]) {
  const snapshot = buildChartSignalSnapshot({ candles, bids, asks })
  if (snapshot.insufficientData) return 0

  switch (snapshot.level) {
    case 'strong_buy':
      return 0.35
    case 'weak_buy':
      return 0.15
    case 'weak_sell':
      return -0.15
    case 'strong_sell':
      return -0.35
    default:
      return 0
  }
}

function avoidOpenOrderCollision(
  price: number,
  side: 'BUY' | 'SELL',
  openOrders: Order[],
) {
  const sameSideOrders = openOrders.filter(
    (order) => order.side === side && order.price !== undefined,
  )
  if (sameSideOrders.length === 0) return price

  const nearest = sameSideOrders.reduce((closest, order) => {
    const orderPrice = order.price!
    const closestDistance = Math.abs(closest - price)
    const orderDistance = Math.abs(orderPrice - price)
    return orderDistance < closestDistance ? orderPrice : closest
  }, sameSideOrders[0].price!)

  if (Math.abs(nearest - price) < 0.02) {
    return side === 'BUY' ? roundUsd(price - 0.01) : roundUsd(price + 0.01)
  }

  return price
}

function clampBuyPrice(
  price: number,
  currentPrice: number,
  bestAsk: number | undefined,
  atr?: number,
) {
  const maxPrice = bestAsk !== undefined ? bestAsk - 0.01 : currentPrice
  const minPrice =
    atr !== undefined
      ? Math.max(0.01, currentPrice - atr * MAX_DISTANCE_ATR_RATIO)
      : currentPrice * 0.97

  return roundUsd(Math.min(maxPrice, Math.max(minPrice, price)))
}

function clampSellPrice(
  price: number,
  currentPrice: number,
  bestBid: number | undefined,
  atr?: number,
) {
  const minPrice = bestBid !== undefined ? bestBid + 0.01 : currentPrice
  const maxPrice =
    atr !== undefined
      ? currentPrice + atr * MAX_DISTANCE_ATR_RATIO
      : currentPrice * 1.03

  return roundUsd(Math.max(minPrice, Math.min(maxPrice, price)))
}

function formatUsd(value: number) {
  return `$${value.toFixed(2)}`
}

export function buildLimitPriceRecommendation(
  input: LimitPriceRecommendationInput,
): LimitPriceRecommendation {
  const {
    side,
    currentPrice,
    candles = [],
    candleInterval = '1m',
    bids = [],
    asks = [],
    trades = [],
    holding,
    targetProfitRatePercent = 3,
    commissionRatePercent,
    commissions = [],
    openOrders = [],
  } = input

  if (currentPrice === undefined || currentPrice <= 0) {
    return {
      available: false,
      priceLabel: '—',
      summary: '현재가를 불러오는 중입니다.',
      reasons: [],
    }
  }

  const bestBid = getBestBid(bids)
  const bestAsk = getBestAsk(asks)
  const spread =
    bestBid !== undefined && bestAsk !== undefined && bestAsk > bestBid
      ? bestAsk - bestBid
      : undefined

  const bollinger = getLatestBollingerBands(candles)
  const { support, resistance } = getSupportResistance(candles)
  const { vwap, dayHigh, dayLow } = getVwapAndDayRange(candles, candleInterval)
  const atr = calculateAtr(candles)
  const tradeFlowBias = getTradeFlowBias(trades, bestBid, bestAsk)
  const signalNudge = getSignalNudge(candles, bids, asks)
  const commissionRate =
    commissionRatePercent ?? resolveUsCommissionRatePercent(commissions)

  const reasons: string[] = []

  if (side === 'BUY') {
    const valueCandidates: { price: number; reason: string }[] = []

    if (bestBid !== undefined && bestBid > 0) {
      valueCandidates.push({ price: bestBid, reason: '최우선 매수호가' })
    }
    if (bollinger?.lower !== undefined && bollinger.lower > 0) {
      valueCandidates.push({ price: bollinger.lower, reason: '볼린저 하단' })
    }
    if (support !== undefined && support > 0) {
      valueCandidates.push({ price: support, reason: '지지선' })
    }
    if (vwap !== undefined && vwap > 0 && vwap <= currentPrice) {
      valueCandidates.push({ price: vwap, reason: 'VWAP' })
    }
    if (dayLow !== undefined && dayLow > 0 && dayLow <= currentPrice) {
      valueCandidates.push({ price: dayLow, reason: '당일 저가' })
    }

    const belowMarket = valueCandidates.filter((item) => item.price <= currentPrice)
    let price =
      belowMarket.length > 0
        ? belowMarket.reduce((best, item) => (item.price > best.price ? item : best)).price
        : currentPrice - (spread ?? currentPrice * 0.001) * 0.5

    const nudge = (signalNudge + tradeFlowBias * 0.3) * (atr ?? currentPrice * 0.002)
    price += nudge

    price = clampBuyPrice(price, currentPrice, bestAsk, atr)
    price = avoidOpenOrderCollision(price, 'BUY', openOrders)

    const usedReasons = belowMarket
      .sort((a, b) => b.price - a.price)
      .slice(0, 3)
      .map((item) => item.reason)

    if (spread !== undefined) reasons.push(`스프레드 ${spread.toFixed(2)}`)
    if (signalNudge > 0) reasons.push('매수 신호')
    if (signalNudge < 0) reasons.push('매도 신호 → 보수적')
    if (tradeFlowBias > 0.1) reasons.push('체결 매수 우세')
    reasons.push(...usedReasons)

    return {
      available: true,
      price,
      priceLabel: formatUsd(price),
      summary: `체결 가능성과 진입가를 균형 맞춘 매수 지정가입니다.`,
      reasons: reasons.slice(0, 4),
    }
  }

  const valueCandidates: { price: number; reason: string }[] = []

  if (bestAsk !== undefined && bestAsk > 0) {
    valueCandidates.push({ price: bestAsk, reason: '최우선 매도호가' })
  }
  if (bollinger?.upper !== undefined && bollinger.upper > 0) {
    valueCandidates.push({ price: bollinger.upper, reason: '볼린저 상단' })
  }
  if (resistance !== undefined && resistance > 0) {
    valueCandidates.push({ price: resistance, reason: '저항선' })
  }
  if (vwap !== undefined && vwap > 0 && vwap >= currentPrice) {
    valueCandidates.push({ price: vwap, reason: 'VWAP' })
  }
  if (dayHigh !== undefined && dayHigh > 0 && dayHigh >= currentPrice) {
    valueCandidates.push({ price: dayHigh, reason: '당일 고가' })
  }

  if (holding && holding.quantity > 0 && holding.averagePrice && holding.averagePrice > 0) {
    const targetPrice = calculateTakeProfitSellPrice(
      holding.averagePrice,
      holding.quantity,
      targetProfitRatePercent,
      getTakeProfitCostContext(holding),
    )
    if (targetPrice > 0) {
      valueCandidates.push({ price: targetPrice, reason: `목표 ${targetProfitRatePercent}%` })
    }

    const breakEven = calculateRoundTripBreakEvenSellPrice(
      holding.averagePrice,
      commissionRate,
    )
    if (breakEven > currentPrice) {
      valueCandidates.push({ price: breakEven, reason: '손익분기' })
    }
  }

  const aboveMarket = valueCandidates.filter((item) => item.price >= currentPrice)
  let price =
    aboveMarket.length > 0
      ? aboveMarket.reduce((best, item) => (item.price < best.price ? item : best)).price
      : currentPrice + (spread ?? currentPrice * 0.001) * 0.5

  const nudge = (signalNudge + tradeFlowBias * 0.3) * (atr ?? currentPrice * 0.002)
  price += nudge

  price = clampSellPrice(price, currentPrice, bestBid, atr)
  price = avoidOpenOrderCollision(price, 'SELL', openOrders)

  const usedReasons = aboveMarket
    .sort((a, b) => a.price - b.price)
    .slice(0, 3)
    .map((item) => item.reason)

  if (spread !== undefined) reasons.push(`스프레드 ${spread.toFixed(2)}`)
  if (signalNudge < 0) reasons.push('매도 신호')
  if (signalNudge > 0) reasons.push('매수 신호 → 보수적')
  if (tradeFlowBias < -0.1) reasons.push('체결 매도 우세')
  reasons.push(...usedReasons)

  return {
    available: true,
    price,
    priceLabel: formatUsd(price),
    summary: '익절·저항·호가를 고려한 매도 지정가입니다.',
    reasons: reasons.slice(0, 4),
  }
}
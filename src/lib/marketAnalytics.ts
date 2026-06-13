import type { CandleInterval, ChartCandle } from '../types'
import type { MicrostructureBias } from './marketMicrostructure'

export interface MarketMetric {
  id: string
  label: string
  value: string
  bias: MicrostructureBias
}

const SUPPORT_RESISTANCE_PERIOD = 20
const ATR_PERIOD = 14

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

function formatSignedPercent(value: number) {
  const sign = value > 0 ? '+' : value < 0 ? '' : ''
  return `${sign}${value.toFixed(2)}%`
}

function getPositionBias(percent: number): MicrostructureBias {
  if (percent >= 0.5) return 'bearish'
  if (percent <= -0.5) return 'bullish'
  return 'neutral'
}

export function buildDayPriceMetrics(
  candles: ChartCandle[],
  interval: CandleInterval,
  currentPrice?: number,
): MarketMetric[] {
  const todayCandles = getTodayCandles(candles, interval)
  if (todayCandles.length === 0 || currentPrice === undefined) {
    return [
      { id: 'vwap', label: 'VWAP', value: '—', bias: 'neutral' },
      { id: 'day-range', label: '당일 고저', value: '—', bias: 'neutral' },
    ]
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

  const vwap = volumeSum > 0 ? vwapNumerator / volumeSum : undefined
  const vwapDelta =
    vwap !== undefined && vwap > 0 ? ((currentPrice - vwap) / vwap) * 100 : undefined

  const highDelta =
    dayHigh > 0 ? ((currentPrice - dayHigh) / dayHigh) * 100 : undefined
  const lowDelta = dayLow > 0 ? ((currentPrice - dayLow) / dayLow) * 100 : undefined

  return [
    {
      id: 'vwap',
      label: 'VWAP',
      value:
        vwapDelta !== undefined
          ? `${formatSignedPercent(vwapDelta)} (${vwap!.toFixed(2)})`
          : '—',
      bias: vwapDelta !== undefined ? getPositionBias(vwapDelta) : 'neutral',
    },
    {
      id: 'day-range',
      label: '당일 고저',
      value:
        highDelta !== undefined && lowDelta !== undefined
          ? `고 ${formatSignedPercent(highDelta)} · 저 ${formatSignedPercent(lowDelta)}`
          : '—',
      bias:
        highDelta !== undefined && lowDelta !== undefined
          ? Math.abs(highDelta) < Math.abs(lowDelta)
            ? 'bearish'
            : Math.abs(lowDelta) < Math.abs(highDelta)
              ? 'bullish'
              : 'neutral'
          : 'neutral',
    },
  ]
}

export function buildSupportResistanceMetrics(candles: ChartCandle[]): MarketMetric[] {
  const sorted = candles.slice().sort((a, b) => a.time - b.time)
  const recent = sorted.slice(-SUPPORT_RESISTANCE_PERIOD)

  if (recent.length < 5) {
    return [
      { id: 'support', label: '지지', value: '—', bias: 'neutral' },
      { id: 'resistance', label: '저항', value: '—', bias: 'neutral' },
    ]
  }

  const support = Math.min(...recent.map((candle) => candle.low))
  const resistance = Math.max(...recent.map((candle) => candle.high))
  const lastClose = recent[recent.length - 1].close
  const supportGap =
    lastClose > 0 ? ((lastClose - support) / lastClose) * 100 : undefined
  const resistanceGap =
    resistance > 0 ? ((resistance - lastClose) / lastClose) * 100 : undefined

  return [
    {
      id: 'support',
      label: '지지',
      value:
        supportGap !== undefined
          ? `${support.toFixed(2)} (-${supportGap.toFixed(2)}%)`
          : '—',
      bias: 'bullish',
    },
    {
      id: 'resistance',
      label: '저항',
      value:
        resistanceGap !== undefined
          ? `${resistance.toFixed(2)} (+${resistanceGap.toFixed(2)}%)`
          : '—',
      bias: 'bearish',
    },
  ]
}

function calculateAtr(candles: ChartCandle[], period = ATR_PERIOD) {
  if (candles.length < period + 1) return undefined

  const sorted = candles.slice().sort((a, b) => a.time - b.time)
  const trueRanges: number[] = []

  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index]
    const previous = sorted[index - 1]
    const range = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    )
    trueRanges.push(range)
  }

  const recent = trueRanges.slice(-period)
  return recent.reduce((sum, value) => sum + value, 0) / recent.length
}

export function buildAtrMetric(
  candles: ChartCandle[],
  currentPrice?: number,
): MarketMetric {
  const atr = calculateAtr(candles)
  if (atr === undefined || currentPrice === undefined || currentPrice <= 0) {
    return { id: 'atr', label: 'ATR', value: '—', bias: 'neutral' }
  }

  const atrPercent = (atr / currentPrice) * 100
  let bias: MicrostructureBias = 'neutral'
  if (atrPercent >= 2) bias = 'bearish'
  else if (atrPercent <= 0.5) bias = 'bullish'

  return {
    id: 'atr',
    label: 'ATR(14)',
    value: `${atr.toFixed(2)} (${atrPercent.toFixed(2)}%)`,
    bias,
  }
}
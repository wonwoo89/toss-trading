import {
  BOLLINGER_PERIOD,
  BOLLINGER_STD_DEV,
  getLatestBollingerBands,
} from './bollingerBands'
import type { ChartCandle } from '../types'
import type { ChartSignalBias, ChartSignalMetric } from './chartSignals'

const MACD_FAST = 12
const MACD_SLOW = 26
const MACD_SIGNAL = 9
const VOLUME_PROFILE_BUCKETS = 12

function calculateEma(values: number[], period: number) {
  if (values.length < period) return undefined

  const multiplier = 2 / (period + 1)
  let ema = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period

  for (let index = period; index < values.length; index += 1) {
    ema = (values[index] - ema) * multiplier + ema
  }

  return ema
}

function calculateEmaSeries(values: number[], period: number) {
  if (values.length < period) return []

  const multiplier = 2 / (period + 1)
  const series: number[] = []
  let ema = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period
  series.push(ema)

  for (let index = period; index < values.length; index += 1) {
    ema = (values[index] - ema) * multiplier + ema
    series.push(ema)
  }

  return series
}

function getMacdMetric(closes: number[]): ChartSignalMetric {
  if (closes.length < MACD_SLOW + MACD_SIGNAL) {
    return { id: 'macd', label: 'MACD', value: '—', bias: 'neutral' }
  }

  const fastSeries = calculateEmaSeries(closes, MACD_FAST)
  const slowSeries = calculateEmaSeries(closes, MACD_SLOW)
  const offset = MACD_SLOW - MACD_FAST
  const macdLine: number[] = []

  for (let index = 0; index < slowSeries.length; index += 1) {
    macdLine.push(fastSeries[index + offset] - slowSeries[index])
  }

  const signalLine = calculateEma(macdLine, MACD_SIGNAL)
  const lastMacd = macdLine[macdLine.length - 1]

  if (signalLine === undefined) {
    return { id: 'macd', label: 'MACD', value: '—', bias: 'neutral' }
  }

  const histogram = lastMacd - signalLine
  const bias: ChartSignalBias =
    histogram > 0 ? 'bullish' : histogram < 0 ? 'bearish' : 'neutral'

  return {
    id: 'macd',
    label: 'MACD',
    value: `${histogram >= 0 ? '+' : ''}${histogram.toFixed(3)}`,
    bias,
  }
}

function getBollingerMetric(candles: ChartCandle[]): ChartSignalMetric {
  if (candles.length < BOLLINGER_PERIOD) {
    return { id: 'bollinger', label: '볼린저', value: '—', bias: 'neutral' }
  }

  const latest = getLatestBollingerBands(candles)
  if (!latest) {
    return { id: 'bollinger', label: '볼린저', value: '—', bias: 'neutral' }
  }

  const { upper, lower } = latest
  const lastClose = candles[candles.length - 1]?.close
  const width = upper - lower

  if (width <= 0 || lastClose === undefined) {
    return { id: 'bollinger', label: '볼린저', value: '—', bias: 'neutral' }
  }

  const position = (lastClose - lower) / width
  let bias: ChartSignalBias = 'neutral'
  let label = '중립'

  if (position >= 0.85) {
    bias = 'bearish'
    label = '상단 근접'
  } else if (position <= 0.15) {
    bias = 'bullish'
    label = '하단 근접'
  } else if (position > 0.55) {
    label = '상단권'
  } else if (position < 0.45) {
    label = '하단권'
  }

  return {
    id: 'bollinger',
    label: '볼린저',
    value: label,
    bias,
  }
}

function getMomentumMetric(candles: ChartCandle[]): ChartSignalMetric {
  if (candles.length < 3) {
    return { id: 'momentum', label: '모멘텀', value: '—', bias: 'neutral' }
  }

  const sorted = candles.slice().sort((a, b) => a.time - b.time)
  const last = sorted[sorted.length - 1]
  const previous = sorted[sorted.length - 2]
  const gapPercent =
    previous.close > 0
      ? ((last.open - previous.close) / previous.close) * 100
      : 0

  let consecutiveUp = 0
  let consecutiveDown = 0

  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const candle = sorted[index]
    if (candle.close > candle.open) {
      if (consecutiveDown > 0) break
      consecutiveUp += 1
    } else if (candle.close < candle.open) {
      if (consecutiveUp > 0) break
      consecutiveDown += 1
    } else {
      break
    }
  }

  let bias: ChartSignalBias = 'neutral'
  let value = '횡보'

  if (consecutiveUp >= 2) {
    bias = 'bullish'
    value = `양봉 ${consecutiveUp}연속`
  } else if (consecutiveDown >= 2) {
    bias = 'bearish'
    value = `음봉 ${consecutiveDown}연속`
  } else if (Math.abs(gapPercent) >= 0.2) {
    bias = gapPercent > 0 ? 'bullish' : 'bearish'
    value = `갭 ${gapPercent > 0 ? '+' : ''}${gapPercent.toFixed(2)}%`
  }

  return { id: 'momentum', label: '모멘텀', value, bias }
}

function getVolumeProfileMetric(candles: ChartCandle[]): ChartSignalMetric {
  const sorted = candles.slice().sort((a, b) => a.time - b.time)
  const recent = sorted.slice(-30)

  if (recent.length < 5) {
    return { id: 'volume-profile', label: '거래량대', value: '—', bias: 'neutral' }
  }

  const low = Math.min(...recent.map((candle) => candle.low))
  const high = Math.max(...recent.map((candle) => candle.high))
  const range = high - low

  if (range <= 0) {
    return { id: 'volume-profile', label: '거래량대', value: '—', bias: 'neutral' }
  }

  const bucketSize = range / VOLUME_PROFILE_BUCKETS
  const buckets = Array.from({ length: VOLUME_PROFILE_BUCKETS }, () => 0)

  for (const candle of recent) {
    const typical = (candle.high + candle.low + candle.close) / 3
    const bucketIndex = Math.min(
      VOLUME_PROFILE_BUCKETS - 1,
      Math.max(0, Math.floor((typical - low) / bucketSize)),
    )
    buckets[bucketIndex] += candle.volume
  }

  const maxVolume = Math.max(...buckets)
  const peakIndex = buckets.indexOf(maxVolume)
  const peakPrice = low + (peakIndex + 0.5) * bucketSize
  const lastClose = recent[recent.length - 1].close
  const delta =
    lastClose > 0 ? ((lastClose - peakPrice) / lastClose) * 100 : undefined

  return {
    id: 'volume-profile',
    label: '거래량대',
    value:
      delta !== undefined
        ? `${peakPrice.toFixed(2)} (${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%)`
        : peakPrice.toFixed(2),
    bias:
      delta !== undefined
        ? delta > 0.5
          ? 'bearish'
          : delta < -0.5
            ? 'bullish'
            : 'neutral'
        : 'neutral',
  }
}

export function buildExtendedIndicatorMetrics(
  candles: ChartCandle[],
): ChartSignalMetric[] {
  const sorted = candles.slice().sort((a, b) => a.time - b.time)
  const closes = sorted.map((candle) => candle.close)

  return [
    getMacdMetric(closes),
    getBollingerMetric(sorted),
    getMomentumMetric(sorted),
    getVolumeProfileMetric(sorted),
  ]
}
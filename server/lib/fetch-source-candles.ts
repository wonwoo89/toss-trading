import type { RawCandle } from './candle-aggregate.js'
import { MAX_CANDLES_PER_REQUEST } from './candle-aggregate.js'
import { tossRequest } from './toss-client.js'

interface CandlePageResult {
  candles: RawCandle[]
  nextBefore: string | null
}

interface FetchSourceCandlesOptions {
  symbol: string
  interval: '1m' | '1d'
  count: number
  before?: string
  adjusted?: boolean
}

export async function fetchSourceCandles({
  symbol,
  interval,
  count,
  before,
  adjusted = true,
}: FetchSourceCandlesOptions): Promise<CandlePageResult> {
  const collected: RawCandle[] = []
  let cursor = before
  let nextBefore: string | null = null
  const maxPages = Math.ceil(count / MAX_CANDLES_PER_REQUEST) + 1

  for (let page = 0; page < maxPages && collected.length < count; page += 1) {
    const pageCount = Math.min(MAX_CANDLES_PER_REQUEST, count - collected.length)
    const data = await tossRequest<{ result: CandlePageResult }>({
      path: '/api/v1/candles',
      query: {
        symbol: symbol.toUpperCase(),
        interval,
        count: pageCount,
        before: cursor,
        adjusted,
      },
    })

    const pageCandles = data.result.candles
    if (pageCandles.length === 0) {
      nextBefore = data.result.nextBefore
      break
    }

    collected.push(...pageCandles)
    nextBefore = data.result.nextBefore

    if (!nextBefore || pageCandles.length < pageCount) {
      break
    }

    cursor = nextBefore
  }

  return {
    candles: collected,
    nextBefore,
  }
}
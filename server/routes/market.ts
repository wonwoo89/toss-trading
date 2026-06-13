import { Router } from 'express'
import {
  aggregateCandles,
  getRequiredSourceCount,
  getSourceInterval,
  isNativeInterval,
  type SupportedCandleInterval,
} from '../lib/candle-aggregate.js'
import { fetchSourceCandles } from '../lib/fetch-source-candles.js'
import { searchStocks } from '../lib/stock-search.js'
import { tossRequest } from '../lib/toss-client.js'

export const marketRouter = Router()

marketRouter.get('/stocks/search', async (req, res, next) => {
  try {
    const q = String(req.query.q ?? '').trim()
    if (!q) {
      res.json({ result: [] })
      return
    }

    const limit = req.query.limit ? Math.min(Number(req.query.limit), 20) : undefined
    const results = await searchStocks(q, limit)
    res.json({ result: results })
  } catch (error) {
    next(error)
  }
})

marketRouter.get('/stocks/:symbol', async (req, res, next) => {
  try {
    const data = await tossRequest({
      path: '/api/v1/stocks',
      query: { symbols: req.params.symbol.toUpperCase() },
    })
    res.json(data)
  } catch (error) {
    next(error)
  }
})

marketRouter.get('/stocks/:symbol/warnings', async (req, res, next) => {
  try {
    const data = await tossRequest({
      path: `/api/v1/stocks/${req.params.symbol.toUpperCase()}/warnings`,
    })
    res.json(data)
  } catch (error) {
    next(error)
  }
})

marketRouter.get('/prices/:symbol', async (req, res, next) => {
  try {
    const data = await tossRequest({
      path: '/api/v1/prices',
      query: { symbols: req.params.symbol.toUpperCase() },
    })
    res.json(data)
  } catch (error) {
    next(error)
  }
})

marketRouter.get('/orderbook/:symbol', async (req, res, next) => {
  try {
    const data = await tossRequest({
      path: '/api/v1/orderbook',
      query: { symbol: req.params.symbol.toUpperCase() },
    })
    res.json(data)
  } catch (error) {
    next(error)
  }
})

marketRouter.get('/trades/:symbol', async (req, res, next) => {
  try {
    const data = await tossRequest({
      path: '/api/v1/trades',
      query: {
        symbol: req.params.symbol.toUpperCase(),
        count: req.query.count ? Number(req.query.count) : 30,
      },
    })
    res.json(data)
  } catch (error) {
    next(error)
  }
})

marketRouter.get('/candles/:symbol', async (req, res, next) => {
  try {
    const interval = ((req.query.interval as string) ?? '1m') as SupportedCandleInterval
    const count = req.query.count ? Number(req.query.count) : 120
    const before = req.query.before ? String(req.query.before) : undefined

    if (isNativeInterval(interval)) {
      const data = await tossRequest({
        path: '/api/v1/candles',
        query: {
          symbol: req.params.symbol.toUpperCase(),
          interval,
          count,
          before,
          adjusted: req.query.adjusted !== 'false',
        },
      })
      res.json(data)
      return
    }

    const sourceInterval = getSourceInterval(interval)
    const sourceCount = getRequiredSourceCount(interval, count)
    const source = await fetchSourceCandles({
      symbol: req.params.symbol.toUpperCase(),
      interval: sourceInterval,
      count: sourceCount,
      before,
      adjusted: req.query.adjusted !== 'false',
    })

    const aggregated = aggregateCandles(source.candles, interval).slice(-count)
    const nextBefore =
      aggregated.length > 0 && source.nextBefore !== null
        ? aggregated[0].timestamp
        : null

    res.json({
      result: {
        candles: aggregated,
        nextBefore,
      },
    })
  } catch (error) {
    next(error)
  }
})

marketRouter.get('/snapshot/:symbol', async (req, res, next) => {
  try {
    const symbol = req.params.symbol.toUpperCase()

    const priceRes = await tossRequest({
      path: '/api/v1/prices',
      query: { symbols: symbol },
    })
    const orderbookRes = await tossRequest({
      path: '/api/v1/orderbook',
      query: { symbol },
    })
    const tradesRes = await tossRequest({
      path: '/api/v1/trades',
      query: { symbol, count: 30 },
    })

    const price = priceRes as { result: unknown }
    const orderbook = orderbookRes as { result: unknown }
    const trades = tradesRes as { result: unknown }

    res.json({
      result: {
        price: price.result,
        orderbook: orderbook.result,
        trades: trades.result,
      },
    })
  } catch (error) {
    next(error)
  }
})

marketRouter.get('/exchange-rate', async (req, res, next) => {
  try {
    const data = await tossRequest({
      path: '/api/v1/exchange-rate',
      query: {
        baseCurrency: (req.query.baseCurrency as string) ?? 'USD',
        quoteCurrency: (req.query.quoteCurrency as string) ?? 'KRW',
        dateTime: req.query.dateTime ? String(req.query.dateTime) : undefined,
      },
    })
    res.json(data)
  } catch (error) {
    next(error)
  }
})

marketRouter.get('/market-calendar/us', async (_req, res, next) => {
  try {
    const data = await tossRequest({ path: '/api/v1/market-calendar/US' })
    res.json(data)
  } catch (error) {
    next(error)
  }
})
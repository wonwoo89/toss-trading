import { Router } from 'express'
import { getDefaultAccountSeq, tossRequest } from '../lib/toss-client.js'

export const ordersRouter = Router()

function resolveAccountSeq(headerValue?: string): string {
  const accountSeq = headerValue ?? getDefaultAccountSeq()
  if (!accountSeq) {
    throw new Error('Account seq is required. Set TOSS_ACCOUNT_SEQ or pass X-Account-Seq header.')
  }
  return accountSeq
}

ordersRouter.get('/', async (req, res, next) => {
  try {
    const data = await tossRequest({
      path: '/api/v1/orders',
      accountSeq: resolveAccountSeq(req.header('x-account-seq') ?? undefined),
      query: {
        status: (req.query.status as string) ?? 'OPEN',
        symbol: req.query.symbol ? String(req.query.symbol).toUpperCase() : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        cursor: req.query.cursor ? String(req.query.cursor) : undefined,
      },
    })
    res.json(data)
  } catch (error) {
    next(error)
  }
})

ordersRouter.get('/:orderId', async (req, res, next) => {
  try {
    const data = await tossRequest({
      path: `/api/v1/orders/${req.params.orderId}`,
      accountSeq: resolveAccountSeq(req.header('x-account-seq') ?? undefined),
    })
    res.json(data)
  } catch (error) {
    next(error)
  }
})

ordersRouter.post('/', async (req, res, next) => {
  try {
    const data = await tossRequest({
      method: 'POST',
      path: '/api/v1/orders',
      accountSeq: resolveAccountSeq(req.header('x-account-seq') ?? undefined),
      body: req.body,
    })
    res.json(data)
  } catch (error) {
    next(error)
  }
})

ordersRouter.post('/:orderId/modify', async (req, res, next) => {
  try {
    const data = await tossRequest({
      method: 'POST',
      path: `/api/v1/orders/${req.params.orderId}/modify`,
      accountSeq: resolveAccountSeq(req.header('x-account-seq') ?? undefined),
      body: req.body,
    })
    res.json(data)
  } catch (error) {
    next(error)
  }
})

ordersRouter.post('/:orderId/cancel', async (req, res, next) => {
  try {
    const data = await tossRequest({
      method: 'POST',
      path: `/api/v1/orders/${req.params.orderId}/cancel`,
      accountSeq: resolveAccountSeq(req.header('x-account-seq') ?? undefined),
      body: req.body ?? {},
    })
    res.json(data)
  } catch (error) {
    next(error)
  }
})
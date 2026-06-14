import { Router } from 'express';
import { getDefaultAccountSeq, tossRequest } from '../lib/toss-client.js';

export const accountRouter = Router();

function resolveAccountSeq(headerValue?: string): string {
  const accountSeq = headerValue ?? getDefaultAccountSeq();
  if (!accountSeq) {
    throw new Error('Account seq is required. Set TOSS_ACCOUNT_SEQ or pass X-Account-Seq header.');
  }
  return accountSeq;
}

accountRouter.get('/accounts', async (_req, res, next) => {
  try {
    const data = await tossRequest({ path: '/api/v1/accounts' });
    res.json(data);
  } catch (error) {
    next(error);
  }
});

accountRouter.get('/holdings', async (req, res, next) => {
  try {
    const data = await tossRequest({
      path: '/api/v1/holdings',
      accountSeq: resolveAccountSeq(req.header('x-account-seq') ?? undefined),
    });
    res.json(data);
  } catch (error) {
    next(error);
  }
});

accountRouter.get('/buying-power', async (req, res, next) => {
  try {
    const data = await tossRequest({
      path: '/api/v1/buying-power',
      accountSeq: resolveAccountSeq(req.header('x-account-seq') ?? undefined),
      query: { currency: (req.query.currency as string) ?? 'USD' },
    });
    res.json(data);
  } catch (error) {
    next(error);
  }
});

accountRouter.get('/snapshot', async (req, res, next) => {
  try {
    const accountSeq = resolveAccountSeq(req.header('x-account-seq') ?? undefined);
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : undefined;

    if (symbol) {
      const [ordersRes, holdingsRes] = await Promise.all([
        tossRequest({
          path: '/api/v1/orders',
          accountSeq,
          query: { status: 'OPEN', symbol },
        }),
        tossRequest({
          path: '/api/v1/holdings',
          accountSeq,
        }),
      ]);

      let sellableRes = null;
      console.log(`[sellable-quantity] symbol=${symbol} - calling /api/v1/sellable-quantity...`);
      try {
        sellableRes = await tossRequest({
          path: '/api/v1/sellable-quantity',
          accountSeq,
          query: { symbol },
        });
        console.log(`[sellable-quantity] symbol=${symbol} - SUCCESS, has result:`, !!sellableRes?.result);
      } catch (err) {
        console.error(`[sellable-quantity] symbol=${symbol} - FAILED:`, err?.message || err);
        sellableRes = null;
      }

      const orders = ordersRes as { result: unknown };
      const sellableQuantity = sellableRes as { result: unknown } | null;
      const holdings = holdingsRes as {
        result: {
          items: { symbol: string }[];
        };
      };
      const holding =
        holdings.result.items.find((item) => item.symbol.toUpperCase() === symbol) ?? null;

      res.json({
        result: {
          orders: orders.result,
          sellableQuantity: sellableQuantity?.result ?? null,
          holding,
        },
      });
      return;
    }

    const buyingPowerRes = await tossRequest({
      path: '/api/v1/buying-power',
      accountSeq,
      query: { currency: 'USD' },
    });
    const holdingsRes = await tossRequest({
      path: '/api/v1/holdings',
      accountSeq,
    });

    const buyingPower = buyingPowerRes as { result: unknown };
    const holdings = holdingsRes as { result: unknown };

    res.json({
      result: {
        buyingPower: buyingPower.result,
        holdings: holdings.result,
      },
    });
  } catch (error) {
    next(error);
  }
});

accountRouter.get('/commissions', async (req, res, next) => {
  try {
    const data = await tossRequest({
      path: '/api/v1/commissions',
      accountSeq: resolveAccountSeq(req.header('x-account-seq') ?? undefined),
    });
    res.json(data);
  } catch (error) {
    next(error);
  }
});

accountRouter.get('/sellable-quantity/:symbol', async (req, res, next) => {
  const sym = req.params.symbol.toUpperCase();
  console.log(`[sellable-quantity] (direct) symbol=${sym} - calling /api/v1/sellable-quantity...`);
  try {
    const data = await tossRequest({
      path: '/api/v1/sellable-quantity',
      accountSeq: resolveAccountSeq(req.header('x-account-seq') ?? undefined),
      query: { symbol: sym },
    });
    console.log(`[sellable-quantity] (direct) symbol=${sym} - SUCCESS, has result:`, !!data?.result);
    res.json(data);
  } catch (error) {
    console.error(`[sellable-quantity] (direct) symbol=${sym} - FAILED:`, error?.message || error);
    next(error);
  }
});

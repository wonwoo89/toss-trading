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

    console.log(`[account/snapshot] HIT - symbol=${symbol || 'none'}, accountSeq present=${!!req.header('x-account-seq')}`);

    if (symbol) {
      console.log(`[account/snapshot] symbol=${symbol} - entering symbol branch, starting orders + holdings fetch`);
      let ordersRes, holdingsRes;
      try {
        [ordersRes, holdingsRes] = await Promise.all([
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
        console.log(`[account/snapshot] symbol=${symbol} - orders + holdings fetch SUCCESS`);
      } catch (fetchErr) {
        console.error(`[account/snapshot] symbol=${symbol} - orders or holdings fetch FAILED:`, fetchErr?.message || fetchErr);
        if (fetchErr?.stack) console.error(fetchErr.stack);
        throw fetchErr;
      }

      let sellableRes = null;
      console.log(`[sellable-quantity] symbol=${symbol} - ABOUT TO CALL /api/v1/sellable-quantity (accountSeq=${accountSeq ? 'yes' : 'no'})`);
      try {
        sellableRes = await tossRequest({
          path: '/api/v1/sellable-quantity',
          accountSeq,
          query: { symbol },
        });
        console.log(`[sellable-quantity] symbol=${symbol} - SUCCESS from /api/v1/sellable-quantity, has result:`, !!sellableRes?.result);
        if (sellableRes?.result) {
          console.log(`[sellable-quantity] symbol=${symbol} - sellable result:`, JSON.stringify(sellableRes.result).slice(0, 200));
        } else {
          console.log(`[sellable-quantity] symbol=${symbol} - SUCCESS but result is null/empty`);
        }
      } catch (err) {
        console.error(`[sellable-quantity] symbol=${symbol} - ERROR calling /api/v1/sellable-quantity:`, err?.message || err);
        if (err?.stack) console.error(err.stack);
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
    console.error(`[account/snapshot] overall handler error (symbol=${symbol || 'none'}):`, error?.message || error);
    if (error?.stack) console.error(error.stack);
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

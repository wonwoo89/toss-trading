import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import cors from 'cors';
import express from 'express';
import { getLastAuthError, getTokenCacheStatus, warmUpAuth } from './lib/auth.js';
import { warmUpStockSearchIndex } from './lib/stock-search.js';
import { TossApiError } from './lib/toss-client.js';
import { accountRouter } from './routes/account.js';
import { marketRouter } from './routes/market.js';
import { ordersRouter } from './routes/orders.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(rootDir, '.env') });

const app = express();
const port = Number(process.env.PORT ?? 3001);

app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  const tokenStatus = getTokenCacheStatus();
  const clientId = process.env.TOSS_CLIENT_ID?.trim() ?? '';
  res.json({
    ok: tokenStatus.cached,
    env: {
      hasClientId: Boolean(clientId),
      hasClientSecret: Boolean(process.env.TOSS_CLIENT_SECRET?.trim()),
      hasAccountSeq: Boolean(process.env.TOSS_ACCOUNT_SEQ?.trim()),
      clientIdPrefix: clientId ? clientId.slice(0, 4) : null,
    },
    auth: tokenStatus.cached
      ? {
          cached: true,
          expiresInMs: tokenStatus.expiresInMs,
        }
      : {
          cached: false,
          lastError: getLastAuthError(),
        },
  });
});

app.post('/api/auth/test', async (_req, res, next) => {
  try {
    await warmUpAuth();
    const status = getTokenCacheStatus();
    res.json({
      ok: true,
      message: 'OAuth token issued successfully',
      expiresInMs: status.expiresInMs,
    });
  } catch (error) {
    next(error);
  }
});

app.use('/api/market', marketRouter);
app.use('/api/account', accountRouter);
app.use('/api/orders', ordersRouter);

app.use(
  (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof TossApiError) {
      res.status(error.status).json({
        error: {
          message: error.message,
          code: error.code,
          requestId: error.requestId,
          data: error.data,
        },
      });
      return;
    }

    if (error instanceof Error) {
      const status = error.message.includes('Token issuance failed') ? 503 : 500;
      res.status(status).json({ error: { message: error.message } });
      return;
    }

    res.status(500).json({ error: { message: 'Unknown server error' } });
  }
);

app.listen(port, () => {
  console.log(`BFF server running at http://localhost:${port}`);
  console.log(`Loaded .env from ${path.join(rootDir, '.env')}`);

  void warmUpAuth()
    .then(() => {
      const status = getTokenCacheStatus();
      console.log(
        `Toss OAuth token ready (expires in ${Math.round((status.expiresInMs ?? 0) / 1000)}s)`
      );
      return warmUpStockSearchIndex();
    })
    .then(() => {
      console.log('Stock search index ready');
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Unknown auth error';
      console.error(`Server warmup failed: ${message}`);
    });
});

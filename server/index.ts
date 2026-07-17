import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import cors from 'cors';
import express from 'express';
import { getLastAuthError, getTokenCacheStatus, warmUpAuth } from './lib/auth.js';
import { startAutoTradeEngine } from './lib/auto-trade-engine.js';
import { warmUpStockSearchIndex } from './lib/stock-search.js';
import { TossApiError } from './lib/toss-client.js';
import { accountRouter } from './routes/account.js';
import { aiRouter } from './routes/ai.js';
import { autoRouter } from './routes/auto.js';
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
app.use('/api/ai', aiRouter);
app.use('/api/auto', autoRouter);

// 운영 모드: 빌드된 프론트(dist)를 정적 서빙하고, /api 가 아닌 GET 은 SPA 진입점으로
// 폴백한다(클라이언트 라우팅). 개발 모드(NODE_ENV !== production)에서는 Vite dev 서버가
// 프론트를 담당하므로 이 블록은 비활성화된다.
if (process.env.NODE_ENV === 'production') {
  const clientDist = path.join(rootDir, 'dist');
  app.use(express.static(clientDist));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) {
      next();
      return;
    }
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.use(
  (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof TossApiError) {
      // 429 면 토스가 권장한 대기 시간을 클라이언트에도 Retry-After(초)로 전달해 폴링이 선제 완화하게 함.
      if (error.status === 429 && error.retryAfterMs !== undefined) {
        res.setHeader('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
      }
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
      // 인증 준비 후 백그라운드 자동매매 엔진 시작(드라이런). 브라우저 없이도 5분봉마다 판단.
      startAutoTradeEngine();
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Unknown auth error';
      console.error(`Server warmup failed: ${message}`);
    });
});

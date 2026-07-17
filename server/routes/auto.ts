import { Router } from 'express';
import {
  AUTO_CANDLE_INTERVAL,
  MAX_AUTO_SYMBOLS,
  MAX_BUY_PERCENT_CAP,
  getAutoTradeConfig,
  saveAutoTradeConfig,
} from '../lib/auto-trade-config.js';
import { getAutoEngineLogs, getAutoEngineStatus } from '../lib/auto-trade-engine.js';

export const autoRouter = Router();

/** 서버 자동매매 엔진 — 설정 조회. 상한 상수도 함께 내려 클라이언트가 UI 검증에 쓴다. */
autoRouter.get('/config', (_req, res) => {
  res.json({
    result: {
      config: getAutoTradeConfig(),
      limits: {
        maxSymbols: MAX_AUTO_SYMBOLS,
        maxBuyPercent: MAX_BUY_PERCENT_CAP,
        candleInterval: AUTO_CANDLE_INTERVAL,
      },
    },
  });
});

/** 설정 저장(전체 교체). 서버가 상한·중복·범위를 정규화해 되돌려준다. */
autoRouter.put('/config', (req, res) => {
  const config = saveAutoTradeConfig(req.body);
  res.json({ result: { config } });
});

/** 백그라운드 엔진 현재 상태 — 클라이언트가 동작 여부·다음 틱·활성 종목을 확인. */
autoRouter.get('/status', (_req, res) => {
  res.json({ result: getAutoEngineStatus() });
});

/** 엔진 판단 로그(최근→과거). 드라이런 판단·계획을 클라이언트에서 열람. */
autoRouter.get('/logs', (req, res) => {
  const limit = req.query.limit ? Math.min(Number(req.query.limit), 300) : 100;
  res.json({ result: getAutoEngineLogs(Number.isFinite(limit) ? limit : 100) });
});

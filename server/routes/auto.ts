import { Router } from 'express';
import {
  AUTO_CANDLE_INTERVAL,
  MAX_AUTO_SYMBOLS,
  MAX_BUY_PERCENT_CAP,
  getAutoTradeConfig,
  saveAutoTradeConfig,
} from '../lib/auto-trade-config.js';

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

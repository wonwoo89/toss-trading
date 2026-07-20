import { Router } from 'express';
import { getLiveTraderStatus, saveLiveConfig } from '../lib/live-trader.js';

export const liveRouter = Router();

/** 서버(포어그라운드) AI 매매 — 상태·로그·포지션. 어느 기기에서 봐도 동일. */
liveRouter.get('/status', (_req, res) => {
  res.json({ result: getLiveTraderStatus() });
});

/** 설정 저장(켜기/끄기·종목·목표/손절 등). 서버가 범위를 정규화해 되돌려준다. */
liveRouter.put('/config', (req, res) => {
  const config = saveLiveConfig(req.body);
  res.json({ result: { config } });
});

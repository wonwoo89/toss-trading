import { Router } from 'express';
import {
  AUTO_CANDLE_INTERVAL,
  MAX_AUTO_SYMBOLS,
  MAX_BUY_PERCENT_CAP,
  getAutoTradeConfig,
  saveAutoTradeConfig,
} from '../lib/auto-trade-config.js';
import { getAutoEngineLogs, getAutoEngineStatus, resetAutoEngine } from '../lib/auto-trade-engine.js';
import { pruneBgLive } from '../lib/bg-live.js';
import { prunePaperPortfolio } from '../lib/paper-portfolio.js';

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
  // 설정에서 빠진 종목의 페이퍼 장부는 정리 — 다시 추가하면 새 $1,000 로 시작.
  prunePaperPortfolio(config.symbols.map((s) => s.symbol));
  // 실거래 해제/제거된 종목의 풀 장부 정리(보유·미체결 없을 때만 삭제 — 안전).
  pruneBgLive(config.symbols.filter((s) => s.live).map((s) => s.symbol));
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

/** 엔진 초기화 — 로그 비우기 + 페이퍼 $1,000 리셋 + 실거래 풀 실계좌 재동기화. */
autoRouter.post('/reset', async (_req, res, next) => {
  try {
    const result = await resetAutoEngine();
    res.json({ result });
  } catch (error) {
    next(error);
  }
});

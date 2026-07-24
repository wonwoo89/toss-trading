import { Router } from 'express';
import {
  getAiAuthMode,
  getAiBacktestAnalysis,
  getAiMarketBriefing,
  getAiTradeDecision,
  isAiConfigured,
  type AiBriefingResult,
  type AiDecisionRequest,
  type BacktestAnalysisRequest,
} from '../lib/ai-decision.js';

export const aiRouter = Router();

aiRouter.get('/status', (_req, res) => {
  res.json({ result: { configured: isAiConfigured(), mode: getAiAuthMode() } });
});

aiRouter.post('/decision', async (req, res, next) => {
  try {
    const body = req.body as AiDecisionRequest;
    if (!body || typeof body.symbol !== 'string' || !Array.isArray(body.candles)) {
      res.status(400).json({ error: { message: 'symbol·candles 필드가 필요합니다.' } });
      return;
    }
    const decision = await getAiTradeDecision(body);
    res.json({ result: decision });
  } catch (error) {
    next(error);
  }
});

/** 백테스트 (익절×손절) 시나리오 요약을 받아 최적 조합을 AI 가 고른다. */
aiRouter.post('/backtest-analysis', async (req, res, next) => {
  try {
    const body = req.body as BacktestAnalysisRequest;
    if (!body || typeof body.symbol !== 'string' || !Array.isArray(body.scenarios)) {
      res.status(400).json({ error: { message: 'symbol·scenarios 필드가 필요합니다.' } });
      return;
    }
    if (body.scenarios.length > 60) {
      res.status(400).json({ error: { message: '시나리오는 최대 60개까지 지원합니다.' } });
      return;
    }
    const analysis = await getAiBacktestAnalysis(body);
    res.json({ result: analysis });
  } catch (error) {
    next(error);
  }
});

// ── 보유 종목 AI 브리핑 — 뉴스·공시 종합(웹 검색 포함, 무거움) ─────────────
// 접속 시 자동 워밍 + 갱신 버튼용. 같은 종목 세트는 60분 캐시를 재사용하고,
// 생성 중 중복 요청은 in-flight 프라미스를 공유해 호출 수를 아낀다.
const BRIEFING_TTL_MS = 60 * 60 * 1000;
const BRIEFING_MAX_SYMBOLS = 15;
interface CachedBriefing extends AiBriefingResult {
  at: number;
  symbols: string[];
}
let briefingCache: { key: string; data: CachedBriefing } | null = null;
let briefingInflight: { key: string; promise: Promise<CachedBriefing> } | null = null;

aiRouter.get('/briefing', async (req, res, next) => {
  try {
    const symbols = String(req.query.symbols ?? '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z][A-Z0-9.]{0,9}$/.test(s))
      .filter((s, i, arr) => arr.indexOf(s) === i)
      .sort()
      .slice(0, BRIEFING_MAX_SYMBOLS);
    if (symbols.length === 0) {
      res.status(400).json({ error: { message: 'symbols 파라미터가 필요합니다.' } });
      return;
    }
    const force = req.query.force === '1' || req.query.force === 'true';
    const key = symbols.join(',');

    if (!force && briefingCache?.key === key && Date.now() - briefingCache.data.at < BRIEFING_TTL_MS) {
      res.json({ result: { ...briefingCache.data, cached: true } });
      return;
    }
    if (briefingInflight?.key === key) {
      res.json({ result: { ...(await briefingInflight.promise), cached: false } });
      return;
    }

    const promise = getAiMarketBriefing(symbols).then((data) => {
      const cached: CachedBriefing = { ...data, at: Date.now(), symbols };
      // 실패(fallback) 결과는 캐시하지 않는다 — 다음 요청/갱신에서 재시도.
      if (!data.fallback) briefingCache = { key, data: cached };
      return cached;
    });
    briefingInflight = { key, promise };
    try {
      const data = await promise;
      res.json({ result: { ...data, cached: false } });
    } finally {
      if (briefingInflight?.key === key) briefingInflight = null;
    }
  } catch (error) {
    next(error);
  }
});

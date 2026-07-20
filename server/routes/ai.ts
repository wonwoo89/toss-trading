import { Router } from 'express';
import {
  getAiAuthMode,
  getAiBacktestAnalysis,
  getAiTradeDecision,
  isAiConfigured,
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

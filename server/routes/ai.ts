import { Router } from 'express';
import {
  getAiTradeDecision,
  isAiConfigured,
  type AiDecisionRequest,
} from '../lib/ai-decision.js';

export const aiRouter = Router();

aiRouter.get('/status', (_req, res) => {
  res.json({ result: { configured: isAiConfigured() } });
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

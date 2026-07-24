import { Router } from 'express';
import {
  getAiAuthMode,
  getAiBacktestAnalysis,
  getAiMarketBriefing,
  getAiSymbolAnalysis,
  getAiTradeDecision,
  isAiConfigured,
  type AiBriefingResult,
  type AiDecisionCandle,
  type AiDecisionRequest,
  type AiSymbolAnalysis,
  type BacktestAnalysisRequest,
} from '../lib/ai-decision.js';
import {
  aggregateCandles,
  getRequiredSourceCount,
  type AggregatedCandle,
  type RawCandle,
} from '../lib/candle-aggregate.js';
import { computeRegime, computeSignal } from '../lib/candle-signals.js';
import { fetchSourceCandles } from '../lib/fetch-source-candles.js';
import { tossRequest } from '../lib/toss-client.js';

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

// ── 종목별 시황 분석 — 캔들·지표 + 웹 검색 심층 리포트(30분 캐시) ────────────
const ANALYSIS_TTL_MS = 30 * 60 * 1000;
interface CachedAnalysis extends AiSymbolAnalysis {
  at: number;
  symbol: string;
}
const analysisCache = new Map<string, CachedAnalysis>();
const analysisInflight = new Map<string, Promise<CachedAnalysis>>();

function candleToAi(c: RawCandle | AggregatedCandle): AiDecisionCandle {
  return {
    t: Math.floor(new Date(c.timestamp).getTime() / 1000),
    o: Number(c.openPrice),
    h: Number(c.highPrice),
    l: Number(c.lowPrice),
    c: Number(c.closePrice),
    v: Number(c.volume),
  };
}

aiRouter.get('/analysis', async (req, res, next) => {
  try {
    const symbol = String(req.query.symbol ?? '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) {
      res.status(400).json({ error: { message: 'symbol 파라미터가 필요합니다.' } });
      return;
    }
    const force = req.query.force === '1' || req.query.force === 'true';

    const cached = analysisCache.get(symbol);
    if (!force && cached && Date.now() - cached.at < ANALYSIS_TTL_MS) {
      res.json({ result: { ...cached, cached: true } });
      return;
    }
    const inflight = analysisInflight.get(symbol);
    if (inflight) {
      res.json({ result: { ...(await inflight), cached: false } });
      return;
    }

    const promise = (async (): Promise<CachedAnalysis> => {
      // 컨텍스트 수집 — 일봉 40개(중기) + 5분봉 60개(당일) + 현재가 + 지표.
      const [dailyRes, sourceRes, priceRes] = await Promise.all([
        fetchSourceCandles({ symbol, interval: '1d', count: 40 }),
        fetchSourceCandles({ symbol, interval: '1m', count: getRequiredSourceCount('5m', 60) }),
        tossRequest<{ result: { lastPrice?: string }[] }>({
          path: '/api/v1/prices',
          query: { symbols: symbol },
        }).catch(() => ({ result: [] as { lastPrice?: string }[] })),
      ]);
      const intraday = aggregateCandles(sourceRes.candles, '5m').slice(-60).map(candleToAi);
      const daily = dailyRes.candles.slice(-40).map(candleToAi);
      const currentPriceRaw = Number(priceRes.result?.[0]?.lastPrice);
      const currentPrice = Number.isFinite(currentPriceRaw) && currentPriceRaw > 0 ? currentPriceRaw : undefined;
      const signal = intraday.length >= 2 ? computeSignal(intraday) : undefined;
      const regime = intraday.length >= 2 ? computeRegime(intraday) : undefined;

      const data = await getAiSymbolAnalysis({
        symbol,
        currentPrice,
        daily,
        intraday,
        signal: signal
          ? { level: signal.level, score: signal.score, rsi: signal.rsi, sma20: signal.sma20, sma50: signal.sma50, atr: signal.atr }
          : undefined,
        regime: regime ? { adx: regime.adx, state: regime.state } : undefined,
      });
      const entry: CachedAnalysis = { ...data, at: Date.now(), symbol };
      // 실패(fallback)는 캐시하지 않는다 — 다음 시도에서 재생성.
      if (!data.fallback) analysisCache.set(symbol, entry);
      return entry;
    })();
    analysisInflight.set(symbol, promise);
    try {
      const data = await promise;
      res.json({ result: { ...data, cached: false } });
    } finally {
      analysisInflight.delete(symbol);
    }
  } catch (error) {
    next(error);
  }
});

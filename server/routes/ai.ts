import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
/** 세트(key)별 브리핑 캐시 — 보유 세트·관심 종목 추가 세트가 공존한다(최대 5세트). */
const briefingCache = new Map<string, CachedBriefing>();
const briefingInflight = new Map<string, Promise<CachedBriefing>>();
const BRIEFING_MAX_KEYS = 5;

// ── 캐시 파일 영속화 — 잦은 배포(서버 재시작)에도 브리핑/분석을 잃지 않게 한다 ──
// 단일 JSON 파일을 통째로 덮어쓰는 방식이라 파일이 쌓이지 않고, 내부 항목은
// 저장 시점에 오래된 것(24시간 경과)과 초과분(분석 30종목)을 자동 정리한다.
const aiCacheRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AI_CACHE_DIR = path.join(aiCacheRootDir, 'server', 'data');
const AI_CACHE_PATH = path.join(AI_CACHE_DIR, 'ai-insight-cache.json');
/** 파일 보존 한도 — TTL(30/60분)이 지나도 재시작 직후 참고용으로 하루까지는 유지. */
const AI_CACHE_KEEP_MS = 24 * 60 * 60 * 1000;
const AI_CACHE_MAX_ANALYSES = 30;

interface PersistedAiCache {
  briefings: Record<string, CachedBriefing>;
  analyses: Record<string, CachedAnalysis>;
}

function pruneAndSaveAiCache(): void {
  const now = Date.now();
  for (const [key, entry] of briefingCache) {
    if (now - entry.at > AI_CACHE_KEEP_MS) briefingCache.delete(key);
  }
  if (briefingCache.size > BRIEFING_MAX_KEYS) {
    const sorted = [...briefingCache.entries()].sort((a, b) => b[1].at - a[1].at);
    briefingCache.clear();
    for (const [key, entry] of sorted.slice(0, BRIEFING_MAX_KEYS)) briefingCache.set(key, entry);
  }
  for (const [symbol, entry] of analysisCache) {
    if (now - entry.at > AI_CACHE_KEEP_MS) analysisCache.delete(symbol);
  }
  if (analysisCache.size > AI_CACHE_MAX_ANALYSES) {
    const sorted = [...analysisCache.entries()].sort((a, b) => b[1].at - a[1].at);
    analysisCache.clear();
    for (const [symbol, entry] of sorted.slice(0, AI_CACHE_MAX_ANALYSES)) {
      analysisCache.set(symbol, entry);
    }
  }
  const payload: PersistedAiCache = {
    briefings: Object.fromEntries(briefingCache),
    analyses: Object.fromEntries(analysisCache),
  };
  try {
    fs.mkdirSync(AI_CACHE_DIR, { recursive: true });
    fs.writeFileSync(AI_CACHE_PATH, JSON.stringify(payload), 'utf8');
  } catch (error) {
    console.error('[ai] 캐시 파일 저장 실패:', error);
  }
}

function loadAiCacheFromDisk(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(AI_CACHE_PATH, 'utf8')) as Partial<PersistedAiCache> & {
      briefing?: { key: string; data: CachedBriefing } | null; // 구버전(단일 캐시) 호환
    };
    const now = Date.now();
    if (raw.briefings && typeof raw.briefings === 'object') {
      for (const [key, entry] of Object.entries(raw.briefings)) {
        if (entry && typeof entry === 'object' && now - (entry as CachedBriefing).at <= AI_CACHE_KEEP_MS) {
          briefingCache.set(key, entry as CachedBriefing);
        }
      }
    } else if (raw.briefing?.data && now - raw.briefing.data.at <= AI_CACHE_KEEP_MS) {
      briefingCache.set(raw.briefing.key, raw.briefing.data);
    }
    if (raw.analyses && typeof raw.analyses === 'object') {
      for (const [symbol, entry] of Object.entries(raw.analyses)) {
        if (entry && typeof entry === 'object' && now - (entry as CachedAnalysis).at <= AI_CACHE_KEEP_MS) {
          analysisCache.set(symbol, entry as CachedAnalysis);
        }
      }
    }
  } catch {
    // 파일 없음/손상 — 빈 캐시로 시작
  }
}

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

    const cachedEntry = briefingCache.get(key);
    if (!force && cachedEntry && Date.now() - cachedEntry.at < BRIEFING_TTL_MS) {
      res.json({ result: { ...cachedEntry, cached: true } });
      return;
    }
    const inflightEntry = briefingInflight.get(key);
    if (inflightEntry) {
      res.json({ result: { ...(await inflightEntry), cached: false } });
      return;
    }

    const promise = getAiMarketBriefing(symbols).then((data) => {
      const cached: CachedBriefing = { ...data, at: Date.now(), symbols };
      // 실패(fallback) 결과는 캐시하지 않는다 — 다음 요청/갱신에서 재시도.
      if (!data.fallback) {
        briefingCache.set(key, cached);
        pruneAndSaveAiCache(); // 갱신 포함 매 성공 생성마다 파일도 함께 업데이트
      }
      return cached;
    });
    briefingInflight.set(key, promise);
    try {
      const data = await promise;
      res.json({ result: { ...data, cached: false } });
    } finally {
      briefingInflight.delete(key);
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
      if (!data.fallback) {
        analysisCache.set(symbol, entry);
        pruneAndSaveAiCache(); // 갱신 포함 매 성공 생성마다 파일도 함께 업데이트
      }
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

// 서버 기동 시 디스크 캐시 복원 — 배포 직후에도 이전 브리핑/분석이 즉시 뜬다.
loadAiCacheFromDisk();

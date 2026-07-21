import {
  AUTO_CANDLE_INTERVAL,
  getAutoTradeConfig,
  type AutoSymbolConfig,
  type AutoTradeConfig,
} from './auto-trade-config.js';
import {
  getAiTradeDecision,
  isAiConfigured,
  type AiAction,
  type AiDecisionCandle,
  type AiDecisionRequest,
} from './ai-decision.js';
import {
  ensureBgLive,
  executeBgLiveBuy,
  getBgLive,
  getBgLiveSummaries,
  markBgLivePrice,
  reconcileBgOrders,
  reconcileLedgerWithAccount,
  runBgLiveGuards,
  sellAllBgLive,
  type BgLiveSummary,
} from './bg-live.js';
import { aggregateCandles, getRequiredSourceCount, type AggregatedCandle } from './candle-aggregate.js';
import { computeSignal, computeTrend } from './candle-signals.js';
import { fetchSourceCandles } from './fetch-source-candles.js';
import {
  applyPaperDecision,
  getPaperSummaries,
  getPaperSummary,
  markPaperPrice,
  updatePaperTracking,
  PAPER_COMMISSION_RATE,
  type PaperFill,
  type PaperSummary,
} from './paper-portfolio.js';
import { tossRequest } from './toss-client.js';
import {
  getUsMarketSession,
  isTradeableSession,
  type UsMarketSessionKind,
} from './us-market-session.js';

/**
 * 서버 백그라운드 자동매매 엔진 — 2단계(드라이런/페이퍼 트레이딩).
 *
 * 브라우저 없이 서버가 5분봉 마감마다 활성 종목을 순회하며 시세 데이터를 모아
 * AI 판단(getAiTradeDecision)을 받고, 종목당 가상 $1,000 장부에 모의 체결한다.
 *
 * 드라이런은 실계좌와 완전히 분리된 "0부터 시작하는" 실험이다:
 *  - AI 에게 주는 포지션·주문가능금액·매도가능수량은 전부 페이퍼 장부 기준.
 *    실계좌 보유가 판단을 오염시키지 않도록 계좌 API 는 아예 호출하지 않는다.
 *  - 실제 주문도 절대 내지 않는다. (3단계에서 실주문 경로가 별도로 추가되며,
 *    그때도 이 페이퍼 장부는 독립적으로 병행 유지된다)
 *
 * 안전:
 *  - 전역 킬스위치(config.enabled=false) 면 어떤 종목도 판단하지 않는다.
 *  - 미국장이 열린 세션(데이/프리/정규/애프터)에서만 AI를 호출한다 — 마감/휴장엔 생략.
 *    (페이퍼 체결은 가상이라 세션별 소수점 제약이 없다)
 *  - 구독(OAuth) 경로는 호출마다 무거운 런타임이 뜨므로 종목을 '순차'로 처리한다.
 */

const TICK_INTERVAL_MS = 5 * 60 * 1000; // 5분봉 주기
const TICK_OFFSET_MS = 20 * 1000; // 봉 마감 후 20초 뒤(데이터 반영 여유) 실행
const CANDLE_TARGET = 60; // AI에 넘길 최근 5분봉 개수
const MAX_LOGS = 300;
/** 추세 홀드 중 고점 대비 허용 하락(%) — 종목 트레일링 설정이 0(끔)일 때의 기본값. */
const TP_HOLD_TRAIL_PCT = 0.5;

// ── 드라이런(페이퍼) 공격성 파라미터 — 가상 $1,000 샌드박스 전용 ─────────────
// 실계좌(live-trader)의 1회 매수 상한(5%)은 절대 건드리지 않는다. 여기 값은 오직
// 가상 장부 시뮬레이션에만 적용돼, $1,000 을 실제로 굴려 다양한 시나리오를 테스트한다.
/** 종목 설정 buyMaxPercent 에 곱하는 페이퍼 공격성 배수(실계좌 대비 몇 배로 담을지). */
const PAPER_AGGRESSION_MULT = 5;
/** 페이퍼 1회 매수 비중 상한(%) — 배수 적용 후에도 이 값을 넘지 않는다. */
const PAPER_BUY_MAX_PERCENT_CAP = 30;
// 즉시 재판단 펄스 — 5분봉 사이에도 의미있는 변동 시 다시 판단해 테스트 표본을 늘린다.
const PULSE_INTERVAL_MS = 20 * 1000; // 20초마다 활성 종목 시세 배치 점검
const PULSE_MIN_INTERVAL_MS = 60 * 1000; // 종목당 최소 재판단 간격(과호출 방지)
const PULSE_PRICE_MOVE_PCT = 0.3; // 마지막 판단가 대비 이 이상 변동 시 즉시 재판단

/** 페이퍼 1회 매수 비중 상한(%) — 종목 설정 × 공격성 배수, 캡 적용. */
function paperBuyCapPercent(symCfg: AutoSymbolConfig): number {
  return Math.min(symCfg.buyMaxPercent * PAPER_AGGRESSION_MULT, PAPER_BUY_MAX_PERCENT_CAP);
}

/** 종목별 마지막 AI 판단 시점의 가격·시각 — 펄스 트리거의 변동 기준. */
const lastAiJudgment = new Map<string, { price: number; t: number }>();

export interface AutoLogEntry {
  id: number;
  t: number; // epoch ms
  symbol: string;
  session: UsMarketSessionKind;
  action: AiAction;
  sizePct: number;
  confidence: number;
  reason: string;
  fallback: boolean;
  currentPrice: number;
  /** 페이퍼 장부 기준 포지션(판단 시점) — 실계좌 보유와 무관. */
  position?: { quantity: number; averagePrice: number; profitLossPct?: number };
  /** 페이퍼(가상 $1,000) 체결 결과 — 체결됐을 때만 fill 이 있고, 수익률은 항상 기록. */
  paper?: { fill?: PaperFill; returnPct: number; equityUsd: number };
  model: string;
}

export interface AutoEngineStatus {
  running: boolean; // 스케줄러 가동 여부
  mode: 'dry-run';
  enabled: boolean; // 전역 킬스위치(config)
  aiConfigured: boolean;
  ticking: boolean; // 현재 틱 진행 중
  activeSymbols: string[];
  lastTickAt: number | null;
  lastTickSession: UsMarketSessionKind | null;
  nextTickAt: number | null;
  lastError: string | null;
  candleInterval: string;
  /** 페이퍼(가상 $1,000/종목) 포트폴리오 현황 — 클라이언트 수익률 표시용. */
  paper: PaperSummary[];
  /** 실거래 종목별 배정 풀 장부 요약(3단계). */
  livePools: BgLiveSummary[];
}

let timer: ReturnType<typeof setTimeout> | null = null;
let ticking = false;
let logSeq = 0;
const logs: AutoLogEntry[] = [];

const status: Omit<AutoEngineStatus, 'paper' | 'livePools'> = {
  running: false,
  mode: 'dry-run',
  enabled: false,
  aiConfigured: false,
  ticking: false,
  activeSymbols: [],
  lastTickAt: null,
  lastTickSession: null,
  nextTickAt: null,
  lastError: null,
  candleInterval: AUTO_CANDLE_INTERVAL,
};

function pushLog(entry: Omit<AutoLogEntry, 'id'>): void {
  logSeq += 1;
  logs.push({ ...entry, id: logSeq });
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
}

export function getAutoEngineStatus(): AutoEngineStatus {
  return { ...status, ticking, paper: getPaperSummaries(), livePools: getBgLiveSummaries() };
}

export function getAutoEngineLogs(limit = 100): AutoLogEntry[] {
  return logs.slice(-limit).reverse(); // 최근 → 과거
}

function toAiCandle(c: AggregatedCandle): AiDecisionCandle {
  return {
    t: Math.floor(new Date(c.timestamp).getTime() / 1000),
    o: Number(c.openPrice),
    h: Number(c.highPrice),
    l: Number(c.lowPrice),
    c: Number(c.closePrice),
    v: Number(c.volume),
  };
}

interface GuardExit {
  fill: PaperFill | null;
  reason: string;
  /** true 면 이번 틱은 보호 로직이 처리했으므로 AI 호출을 생략한다. */
  handled: boolean;
}

/**
 * 기계적 보호 로직(클라이언트 AI 매매와 동일 규칙) — 매 틱 AI 판단에 앞서 검사한다.
 *  1) 손절: 평단 대비 -손절률 도달 → 즉시 가상 전량 매도(AI 재량에 맡기지 않음).
 *  2) 익절 + 추세 홀드: 수수료 반영 목표가 도달 시 상승 추세(연속 양봉 확정)면 매도를
 *     보류하고 고점 추적. 보전선(목표가) 또는 고점 대비 트레일 % 이탈 시 전량 매도 —
 *     최악의 경우에도 목표 수익은 확보된다.
 *  3) 트레일링 스탑(설정 시): 관측 고점 대비 설정 % 하락 시 전량 매도.
 * 추적 상태(홀드 고점·관측 고점)는 장부 파일에 영속돼 재시작 후에도 이어진다.
 */
function runPaperGuards(
  symCfg: AutoSymbolConfig,
  currentPrice: number,
  candles: AiDecisionCandle[],
  /** 'protect' = 1분 보호 틱 — 캔들(추세) 없이 하락 보호(손절/보전선/트레일)만 수행.
   *  익절 진입 판정(추세 홀드 시작/즉시 익절)은 추세를 아는 5분 틱('full')에서만. */
  mode: 'full' | 'protect' = 'full'
): GuardExit | null {
  const symbol = symCfg.symbol;
  const pos = getPaperSummary(symbol);
  if (!pos || pos.quantity <= 0 || pos.averagePrice <= 0) return null;

  const avg = pos.averagePrice;
  const plPct = ((currentPrice - avg) / avg) * 100;
  const r = PAPER_COMMISSION_RATE;
  // 수수료 반영 익절 목표가(왕복) — 센트 올림으로 목표 실수익 미달 방지(클라이언트와 동일 공식).
  const tpPrice =
    Math.ceil(((avg * (1 + symCfg.targetPercent / 100 + r)) / (1 - r)) * 100 - 1e-9) / 100;
  const slPrice = avg * (1 - symCfg.stopLossPercent / 100);

  // 관측 고점 갱신(트레일링용) — 초기값 max(평단, 현재가).
  const trailPeak = Math.max(pos.trailPeak ?? Math.max(avg, currentPrice), currentPrice);
  if (trailPeak !== pos.trailPeak) updatePaperTracking(symbol, { trailPeak });

  // 1) 손절 — 최우선.
  if (currentPrice <= slPrice) {
    const fill = applyPaperDecision(symbol, 'SELL', 100, currentPrice);
    return {
      fill,
      handled: true,
      reason: `손절 매도(자동): 평단 $${avg.toFixed(2)} 대비 ${plPct.toFixed(2)}% ≤ -${symCfg.stopLossPercent}%`,
    };
  }

  const holdTrailPct =
    symCfg.trailingStopPercent > 0 ? symCfg.trailingStopPercent : TP_HOLD_TRAIL_PCT;

  // 2-a) 추세 홀드 중: 고점 갱신 + 이탈 판정.
  if (pos.tpHoldPeak !== null && pos.tpHoldPeak !== undefined) {
    const peak = Math.max(pos.tpHoldPeak, currentPrice);
    if (peak !== pos.tpHoldPeak) updatePaperTracking(symbol, { tpHoldPeak: peak });
    const floorHit = currentPrice <= tpPrice;
    const trailHit = currentPrice <= peak * (1 - holdTrailPct / 100);
    if (floorHit || trailHit) {
      const fill = applyPaperDecision(symbol, 'SELL', 100, currentPrice);
      const why = floorHit
        ? `보전선 $${tpPrice.toFixed(2)} 이탈`
        : `고점 $${peak.toFixed(2)} 대비 -${holdTrailPct}%`;
      return { fill, handled: true, reason: `익절 매도(추세홀드 종료): ${why}` };
    }
    return null; // 홀드 유지 — AI 판단은 계속 진행(BUY/SELL 재량 허용)
  }

  // 2-b) 목표 도달: 상승 추세면 홀드 시작, 아니면 즉시 익절. (full 틱 전용 — 추세 판단 필요)
  if (mode === 'full' && currentPrice >= tpPrice) {
    const trend = computeTrend(candles);
    if (trend.state === 'up' && trend.confirmedBars >= 2) {
      updatePaperTracking(symbol, { tpHoldPeak: currentPrice });
      return {
        fill: null,
        handled: true,
        reason: `익절 보류(상승 추세 ${trend.confirmedBars}봉) — 고점 추적 시작, 보전선 $${tpPrice.toFixed(2)}`,
      };
    }
    const fill = applyPaperDecision(symbol, 'SELL', 100, currentPrice);
    return {
      fill,
      handled: true,
      reason: `익절 매도(자동): 목표 +${symCfg.targetPercent}% 도달(수수료 반영 $${tpPrice.toFixed(2)})`,
    };
  }

  // 3) 트레일링 스탑(설정 시) — 익절/손절 범위 밖에서 고점 대비 하락.
  if (symCfg.trailingStopPercent > 0 && currentPrice <= trailPeak * (1 - symCfg.trailingStopPercent / 100)) {
    const fill = applyPaperDecision(symbol, 'SELL', 100, currentPrice);
    return {
      fill,
      handled: true,
      reason: `트레일링 매도(자동): 고점 $${trailPeak.toFixed(2)} 대비 -${symCfg.trailingStopPercent}%`,
    };
  }

  return null;
}

/** 보호 로직 발화 결과를 판단 로그에 기록 — 5분 틱과 1분 보호 틱이 공유. */
function logGuardOutcome(
  symbol: string,
  session: UsMarketSessionKind,
  currentPrice: number,
  guardPos: PaperSummary | undefined,
  guard: GuardExit
): void {
  const after = getPaperSummary(symbol);
  pushLog({
    t: Date.now(),
    symbol,
    session,
    action: guard.fill ? 'SELL' : 'HOLD',
    sizePct: guard.fill ? 100 : 0,
    confidence: 1,
    reason: guard.reason,
    fallback: false,
    currentPrice,
    position:
      guardPos && guardPos.quantity > 0 && guardPos.averagePrice > 0
        ? {
            quantity: guardPos.quantity,
            averagePrice: guardPos.averagePrice,
            profitLossPct:
              ((currentPrice - guardPos.averagePrice) / guardPos.averagePrice) * 100,
          }
        : undefined,
    paper: after
      ? {
          fill: guard.fill ?? undefined,
          returnPct: after.returnPct,
          equityUsd: after.equityUsd,
        }
      : undefined,
    model: 'guard',
  });
}

interface LiveEvalCtx {
  candles: AiDecisionCandle[];
  currentPrice: number;
  currency: string;
  bids: { p: number; q: number }[];
  asks: { p: number; q: number }[];
  bidTotal: number;
  askTotal: number;
  signal: ReturnType<typeof computeSignal>;
  trend: ReturnType<typeof computeTrend>;
}

/**
 * 실거래(3단계) 판단 경로 — 배정 풀 장부 기준.
 * 미체결 대조/취소 → 보호 가드(실매도) → AI 판단 → 실매수/실매도.
 * 미체결 방어는 단일 종목 트레이더와 동일(체결 우선 지정가 + 90s/0.2% 취소).
 */
async function evaluateSymbolLive(
  symCfg: AutoSymbolConfig,
  config: AutoTradeConfig,
  session: UsMarketSessionKind,
  ctx: LiveEvalCtx
): Promise<void> {
  const symbol = symCfg.symbol;
  const { candles, currentPrice, currency, bids, asks, bidTotal, askTotal, signal, trend } = ctx;
  const isRegular = session === 'regular';

  const pool = ensureBgLive(symbol, symCfg.poolUsd);
  markBgLivePrice(symbol, currentPrice);

  const liveLog = (
    action: AiAction,
    reason: string,
    model: string,
    extra?: { sizePct?: number; confidence?: number; fallback?: boolean }
  ) => {
    const pos = getBgLive(symbol);
    pushLog({
      t: Date.now(),
      symbol,
      session,
      action,
      sizePct: extra?.sizePct ?? 0,
      confidence: extra?.confidence ?? 1,
      reason,
      fallback: extra?.fallback ?? false,
      currentPrice,
      position:
        pos && pos.quantity > 0 && pos.averagePrice > 0
          ? {
              quantity: pos.quantity,
              averagePrice: pos.averagePrice,
              profitLossPct: ((currentPrice - pos.averagePrice) / pos.averagePrice) * 100,
            }
          : undefined,
      model,
    });
  };

  // 0) 미체결 대조 — 체결 확정/오래된 미체결 취소(부분 체결분 유지·잔량만 롤백).
  for (const note of await reconcileBgOrders(symbol, currentPrice)) {
    liveLog('HOLD', note, 'live-order');
  }
  // 0-b) 장부↔실계좌 정합 — 부분 체결/외부 매도로 장부가 실제보다 많으면 실제값으로 보정.
  const ledgerNote = await reconcileLedgerWithAccount(symbol);
  if (ledgerNote) liveLog('HOLD', `[실거래] ${ledgerNote}`, 'live-reconcile');

  // 1) 보호 가드(실매도) — 발화 시 이번 틱 AI 생략.
  const guard = await runBgLiveGuards(symCfg, currentPrice, candles, session, 'full');
  if (guard) {
    liveLog(guard.sold ? 'SELL' : 'HOLD', `[실거래] ${guard.reason}`, 'live-guard', {
      sizePct: guard.sold ? 100 : 0,
    });
    if (guard.forcedOff) liveLog('HOLD', '일일 손실 한도 도달 — 백그라운드 엔진 전역 OFF', 'live-guard');
    if (guard.handled) return;
  }

  // 2) AI 판단 — 컨텍스트는 풀 장부 기준.
  const sellableQty = isRegular ? pool.quantity : Math.floor(pool.quantity);
  const request: AiDecisionRequest = {
    symbol,
    interval: AUTO_CANDLE_INTERVAL,
    currency,
    currentPrice,
    position:
      pool.quantity > 0 && pool.averagePrice > 0
        ? {
            quantity: pool.quantity,
            averagePrice: pool.averagePrice,
            profitLossPct: ((currentPrice - pool.averagePrice) / pool.averagePrice) * 100,
          }
        : undefined,
    buyingPower: Math.round(pool.cash * 100) / 100,
    maxBuyQuantity: pool.cash > 0 ? Math.floor((pool.cash / currentPrice) * 1e4) / 1e4 : undefined,
    sellableQuantity: pool.quantity > 0 ? Math.max(0, sellableQty) : undefined,
    targetProfitPct: symCfg.targetPercent,
    stopLossPct: symCfg.stopLossPercent,
    signal: { level: signal.level, score: signal.score, rsi: signal.rsi, sma20: signal.sma20, sma50: signal.sma50, atr: signal.atr },
    trend: { state: trend.state, confirmedBars: trend.confirmedBars },
    orderbook: {
      bestBid: bids[0]?.p,
      bestAsk: asks[0]?.p,
      bidRatio: bidTotal + askTotal > 0 ? bidTotal / (bidTotal + askTotal) : undefined,
      bids: bids.slice(0, 5),
      asks: asks.slice(0, 5),
    },
    openOrders: getBgLive(symbol)?.openOrders.slice(0, 10).map((o) => ({
      side: o.side,
      price: o.price,
      quantity: o.quantity,
    })) ?? [],
    guards: {
      trailingStopPct: symCfg.trailingStopPercent > 0 ? symCfg.trailingStopPercent : undefined,
      buyMaxPercent: symCfg.buyMaxPercent,
      dailyLossLimitUsd: config.dailyLossLimitUsd > 0 ? config.dailyLossLimitUsd : undefined,
    },
    candles,
  };

  // 펄스 트리거 기준 갱신 — 실거래도 ±0.3% 급변 시 즉시 재판단 대상.
  lastAiJudgment.set(symbol, { price: currentPrice, t: Date.now() });

  const decision = await getAiTradeDecision(request);
  liveLog(decision.action, `[실거래] ${decision.reason}`, decision.model, {
    sizePct: decision.sizePct,
    confidence: decision.confidence,
    fallback: Boolean(decision.fallback),
  });

  if (decision.fallback || decision.action === 'HOLD') return;
  if (decision.action === 'BUY') {
    // 같은 방향 미체결이 있으면 중복 진입 방지(미체결 취소 후 다음 판단에서 재시도).
    if (getBgLive(symbol)?.openOrders.some((o) => o.side === 'BUY')) {
      liveLog('HOLD', '[실거래] 매수 보류 — 미체결 매수 주문 존재', 'live-exec');
      return;
    }
    const res = await executeBgLiveBuy(
      symCfg,
      { price: currentPrice, bestAsk: asks[0]?.p },
      session,
      decision.sizePct,
      decision.reason
    );
    liveLog(res.ok ? 'BUY' : 'HOLD', `[실거래] ${res.text}`, 'live-exec', {
      sizePct: decision.sizePct,
    });
  } else {
    const res = await sellAllBgLive(
      symCfg,
      { price: currentPrice, bestBid: bids[0]?.p },
      session,
      `AI 매도(전량) — ${decision.reason.slice(0, 80)}`
    );
    liveLog(res.ok ? 'SELL' : 'HOLD', `[실거래] ${res.text}`, 'live-exec', { sizePct: 100 });
    if (res.forcedOff) liveLog('HOLD', '일일 손실 한도 도달 — 백그라운드 엔진 전역 OFF', 'live-exec');
  }
}

async function evaluateSymbol(
  symCfg: AutoSymbolConfig,
  config: AutoTradeConfig,
  session: UsMarketSessionKind
): Promise<void> {
  const symbol = symCfg.symbol;

  // 1) 5분봉 — 1분봉을 받아 서버에서 집계.
  const sourceCount = getRequiredSourceCount(AUTO_CANDLE_INTERVAL, CANDLE_TARGET);
  const source = await fetchSourceCandles({
    symbol,
    interval: '1m',
    count: sourceCount,
    adjusted: true,
  });
  const aggregated = aggregateCandles(source.candles, AUTO_CANDLE_INTERVAL).slice(-CANDLE_TARGET);
  if (aggregated.length < 2) {
    throw new Error('캔들 부족');
  }
  const candles = aggregated.map(toAiCandle);

  // 2) 현재가·호가 — 공개 시세만. 계좌 API 는 드라이런에서 사용하지 않는다.
  const [priceRes, orderbookRes] = await Promise.all([
    tossRequest<{ result: { lastPrice?: string; currency?: string }[] }>({
      path: '/api/v1/prices',
      query: { symbols: symbol },
    }),
    tossRequest<{
      result: { bids?: { price: string; volume: string }[]; asks?: { price: string; volume: string }[] };
    }>({ path: '/api/v1/orderbook', query: { symbol } }),
  ]);

  const priceInfo = priceRes.result?.[0];
  const currentPrice = Number(priceInfo?.lastPrice);
  const currency = priceInfo?.currency ?? 'USD';
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    throw new Error('현재가 없음');
  }

  const bids = (orderbookRes.result?.bids ?? []).map((b) => ({
    p: Number(b.price),
    q: Number(b.volume),
  }));
  const asks = (orderbookRes.result?.asks ?? []).map((a) => ({
    p: Number(a.price),
    q: Number(a.volume),
  }));
  const bidTotal = bids.reduce((s, b) => s + b.q, 0);
  const askTotal = asks.reduce((s, a) => s + a.q, 0);

  const signal = computeSignal(candles);
  const trend = computeTrend(candles);

  // ── 실거래(3단계) 분기 — 배정 풀 장부 기준으로 실제 주문 ──
  if (symCfg.live) {
    await evaluateSymbolLive(symCfg, config, session, {
      candles,
      currentPrice,
      currency,
      bids,
      asks,
      bidTotal,
      askTotal,
      signal,
      trend,
    });
    return;
  }

  // 3) 판단 컨텍스트는 페이퍼 장부 기준 — 가상 $1,000 에서 0 부터 시작하는 실험.
  //    (markPaperPrice 가 장부 항목을 생성/평가가 갱신해 요약이 항상 존재하게 한다)
  markPaperPrice(symbol, currentPrice);

  // 기계적 보호 로직(손절/익절+추세홀드/트레일링) — AI 판단에 앞서 코드가 강제한다.
  const guardPos = getPaperSummary(symbol);
  const guard = runPaperGuards(symCfg, currentPrice, candles);
  if (guard?.handled) {
    logGuardOutcome(symbol, session, currentPrice, guardPos, guard);
    return; // 이번 틱은 보호 로직이 처리 — AI 호출 생략(다음 틱부터 재개)
  }

  const paperBefore = getPaperSummary(symbol);
  const paperCash = paperBefore?.cash ?? 0;
  const paperQty = paperBefore?.quantity ?? 0;
  const paperAvg = paperBefore?.averagePrice ?? 0;

  const position =
    paperQty > 0 && paperAvg > 0
      ? {
          quantity: paperQty,
          averagePrice: paperAvg,
          profitLossPct: ((currentPrice - paperAvg) / paperAvg) * 100,
        }
      : undefined;

  const request: AiDecisionRequest = {
    symbol,
    interval: AUTO_CANDLE_INTERVAL,
    currency,
    currentPrice,
    position,
    buyingPower: Math.round(paperCash * 100) / 100,
    maxBuyQuantity:
      paperCash > 0 ? Math.floor((paperCash / currentPrice) * 1e4) / 1e4 : undefined,
    sellableQuantity: paperQty > 0 ? paperQty : undefined,
    targetProfitPct: symCfg.targetPercent,
    stopLossPct: symCfg.stopLossPercent,
    signal: { level: signal.level, score: signal.score, rsi: signal.rsi, sma20: signal.sma20, sma50: signal.sma50, atr: signal.atr },
    trend: { state: trend.state, confirmedBars: trend.confirmedBars },
    orderbook: {
      bestBid: bids[0]?.p,
      bestAsk: asks[0]?.p,
      bidRatio: bidTotal + askTotal > 0 ? bidTotal / (bidTotal + askTotal) : undefined,
      bids: bids.slice(0, 5),
      asks: asks.slice(0, 5),
    },
    // 페이퍼 장부는 현재가 즉시 체결 가정이라 미체결 주문이 없다.
    openOrders: [],
    guards: {
      trailingStopPct: symCfg.trailingStopPercent > 0 ? symCfg.trailingStopPercent : undefined,
      // 페이퍼 샌드박스는 공격성 배수 적용 상한을 알려, AI 가 더 큰 비중을 제안할 수 있게 한다.
      buyMaxPercent: paperBuyCapPercent(symCfg),
      dailyLossLimitUsd: config.dailyLossLimitUsd > 0 ? config.dailyLossLimitUsd : undefined,
    },
    candles,
  };

  // 펄스 트리거 기준 갱신 — AI 판단이 실제로 나가는 이 시점의 가격·시각을 기록.
  lastAiJudgment.set(symbol, { price: currentPrice, t: Date.now() });

  const decision = await getAiTradeDecision(request);

  // 페이퍼 체결 — 가상 $1,000 장부에 반영. 매수는 종목 설정의 1회 매수 상한을 그대로 적용해
  // 실주문 모드가 했을 비중과 동일하게 시뮬레이션한다. HOLD/폴백은 평가 가격만 갱신(위에서 완료).
  let paperFill: PaperFill | null = null;
  if (!decision.fallback && decision.action !== 'HOLD') {
    const paperPct =
      decision.action === 'BUY'
        ? Math.min(decision.sizePct, paperBuyCapPercent(symCfg))
        : decision.sizePct;
    paperFill = applyPaperDecision(symbol, decision.action, paperPct, currentPrice);
  }
  const paperSummary = getPaperSummary(symbol);

  pushLog({
    t: Date.now(),
    symbol,
    session,
    action: decision.action,
    sizePct: decision.sizePct,
    confidence: decision.confidence,
    reason: decision.reason,
    fallback: Boolean(decision.fallback),
    currentPrice,
    position,
    paper: paperSummary
      ? {
          fill: paperFill ?? undefined,
          returnPct: paperSummary.returnPct,
          equityUsd: paperSummary.equityUsd,
        }
      : undefined,
    model: decision.model,
  });
}

async function runTick(): Promise<void> {
  if (ticking) return;

  const config = getAutoTradeConfig();
  status.enabled = config.enabled;
  status.aiConfigured = isAiConfigured();
  status.lastTickAt = Date.now();

  const activeSymbols = config.enabled ? config.symbols.filter((s) => s.active) : [];
  status.activeSymbols = activeSymbols.map((s) => s.symbol);

  if (!config.enabled) {
    status.lastTickSession = null;
    return; // 전역 킬스위치 OFF
  }
  if (activeSymbols.length === 0) return;
  if (!isAiConfigured()) {
    status.lastError = 'AI 미설정(ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN 없음)';
    return;
  }

  const session = await getUsMarketSession();
  status.lastTickSession = session;
  if (!isTradeableSession(session)) return; // 장 마감/휴장만 생략 — 열린 세션은 모두 판단

  ticking = true;
  try {
    for (const symCfg of activeSymbols) {
      try {
        await evaluateSymbol(symCfg, config, session);
      } catch (err) {
        const message = err instanceof Error ? err.message : '알 수 없는 오류';
        status.lastError = `${symCfg.symbol}: ${message}`;
        pushLog({
          t: Date.now(),
          symbol: symCfg.symbol,
          session,
          action: 'HOLD',
          sizePct: 0,
          confidence: 0,
          reason: `데이터/판단 실패: ${message}`,
          fallback: true,
          currentPrice: 0,
          model: 'error',
        });
      }
    }
    if (status.lastError && status.lastError.startsWith('AI 미설정')) status.lastError = null;
  } catch (err) {
    status.lastError = err instanceof Error ? err.message : '틱 실패';
  } finally {
    ticking = false;
  }
}

/**
 * 1분 보호 틱 — AI 없이 현재가만 배치 조회해 하락 보호(손절/보전선/트레일)만 판정한다.
 * 5분 판단 틱 사이의 급락에도 손절이 최대 1분 안에 걸리게 한다. 포지션이 있는 종목이
 * 없으면 시세 호출도 생략하므로 부담이 거의 없다(분당 시세 API 최대 1회).
 */
const GUARD_TICK_INTERVAL_MS = 60 * 1000;
let guardTimer: ReturnType<typeof setInterval> | null = null;
let guardTicking = false;

async function runGuardTick(): Promise<void> {
  if (guardTicking) return;
  const config = getAutoTradeConfig();
  if (!config.enabled) return;
  const withPosition = config.symbols.filter((s) => {
    if (!s.active) return false;
    if (s.live) {
      const pool = getBgLive(s.symbol);
      // 보유가 있거나 미체결이 남아 있으면(취소 판정 필요) 1분 틱 대상.
      return Boolean(pool && (pool.quantity > 0 || pool.openOrders.length > 0));
    }
    return (getPaperSummary(s.symbol)?.quantity ?? 0) > 0;
  });
  if (withPosition.length === 0) return;

  const session = await getUsMarketSession();
  if (!isTradeableSession(session)) return;

  guardTicking = true;
  try {
    // 활성 보유 종목 현재가를 한 번에 조회(콤마 배치).
    const res = await tossRequest<{ result: { symbol?: string; lastPrice?: string }[] }>({
      path: '/api/v1/prices',
      query: { symbols: withPosition.map((s) => s.symbol).join(',') },
    });
    const priceMap = new Map<string, number>();
    for (const p of res.result ?? []) {
      const v = Number(p.lastPrice);
      if (p.symbol && Number.isFinite(v) && v > 0) priceMap.set(p.symbol.toUpperCase(), v);
    }

    for (const symCfg of withPosition) {
      const price = priceMap.get(symCfg.symbol);
      if (price === undefined) continue;

      if (symCfg.live) {
        // 실거래: 미체결 대조/취소 + 장부 정합 + 하락 보호(실매도). 로그는 pushLog 로 남긴다.
        markBgLivePrice(symCfg.symbol, price);
        const notes = await reconcileBgOrders(symCfg.symbol, price);
        const ledgerNote = await reconcileLedgerWithAccount(symCfg.symbol);
        const guard = await runBgLiveGuards(symCfg, price, [], session, 'protect');
        const entries: { action: AiAction; reason: string; model: string }[] = [
          ...notes.map((n) => ({ action: 'HOLD' as AiAction, reason: n, model: 'live-order' })),
          ...(ledgerNote ? [{ action: 'HOLD' as AiAction, reason: `[실거래] ${ledgerNote}`, model: 'live-reconcile' }] : []),
          ...(guard
            ? [{ action: (guard.sold ? 'SELL' : 'HOLD') as AiAction, reason: `[실거래] ${guard.reason}`, model: 'live-guard' }]
            : []),
        ];
        for (const e of entries) {
          const pos = getBgLive(symCfg.symbol);
          pushLog({
            t: Date.now(),
            symbol: symCfg.symbol,
            session,
            action: e.action,
            sizePct: e.action === 'SELL' ? 100 : 0,
            confidence: 1,
            reason: e.reason,
            fallback: false,
            currentPrice: price,
            position:
              pos && pos.quantity > 0 && pos.averagePrice > 0
                ? {
                    quantity: pos.quantity,
                    averagePrice: pos.averagePrice,
                    profitLossPct: ((price - pos.averagePrice) / pos.averagePrice) * 100,
                  }
                : undefined,
            model: e.model,
          });
        }
        continue;
      }

      markPaperPrice(symCfg.symbol, price); // 수익률 표시도 1분 단위로 갱신
      const guardPos = getPaperSummary(symCfg.symbol);
      const guard = runPaperGuards(symCfg, price, [], 'protect');
      if (guard?.handled) {
        logGuardOutcome(symCfg.symbol, session, price, guardPos, guard);
      }
    }
  } catch (err) {
    // 보호 틱 실패는 다음 분에 자동 재시도 — 상태만 남긴다.
    status.lastError = `보호 틱 실패: ${err instanceof Error ? err.message : '오류'}`;
  } finally {
    guardTicking = false;
  }
}

/**
 * 즉시 재판단 펄스(드라이런 전용) — 20초마다 활성 종목 현재가를 배치 조회해, 마지막 AI
 * 판단가 대비 ±0.3% 이상 움직였고 종목당 최소 간격(60초)이 지난 종목만 즉시 재판단한다.
 * 5분봉 마감만 기다리지 않고 급변 구간을 잡아 표본을 늘려, $1,000 샌드박스가 다양한
 * 시나리오를 테스트하게 한다. AI 호출은 기존 구독 직렬 대기열 + 하드 타임아웃 안전장치를 탄다.
 */
let pulseTimer: ReturnType<typeof setInterval> | null = null;
let pulseTicking = false;

async function runPulseTick(): Promise<void> {
  if (pulseTicking || ticking) return; // 5분 틱과 겹치지 않게
  const config = getAutoTradeConfig();
  if (!config.enabled || !isAiConfigured()) return;
  const activeSymbols = config.symbols.filter((s) => s.active);
  if (activeSymbols.length === 0) return;

  const session = await getUsMarketSession();
  if (!isTradeableSession(session)) return;

  pulseTicking = true;
  try {
    const res = await tossRequest<{ result: { symbol?: string; lastPrice?: string }[] }>({
      path: '/api/v1/prices',
      query: { symbols: activeSymbols.map((s) => s.symbol).join(',') },
    });
    const priceMap = new Map<string, number>();
    for (const p of res.result ?? []) {
      const v = Number(p.lastPrice);
      if (p.symbol && Number.isFinite(v) && v > 0) priceMap.set(p.symbol.toUpperCase(), v);
    }

    const now = Date.now();
    for (const symCfg of activeSymbols) {
      const price = priceMap.get(symCfg.symbol);
      if (price === undefined) continue;
      const last = lastAiJudgment.get(symCfg.symbol);
      // 첫 판단 전(5분 틱이 기준가를 세우기 전)이면 펄스는 쉰다.
      if (!last) continue;
      if (now - last.t < PULSE_MIN_INTERVAL_MS) continue;
      const movedPct = last.price > 0 ? (Math.abs(price - last.price) / last.price) * 100 : 0;
      if (movedPct < PULSE_PRICE_MOVE_PCT) continue;
      try {
        await evaluateSymbol(symCfg, config, session);
      } catch (err) {
        status.lastError = `${symCfg.symbol}(펄스): ${err instanceof Error ? err.message : '오류'}`;
      }
    }
  } catch (err) {
    status.lastError = `펄스 틱 실패: ${err instanceof Error ? err.message : '오류'}`;
  } finally {
    pulseTicking = false;
  }
}

/** 다음 5분봉 마감 + 오프셋 시각까지 남은 ms. 너무 임박하면 다음 주기로. */
function nextTickDelay(now: number): number {
  const boundary = Math.ceil(now / TICK_INTERVAL_MS) * TICK_INTERVAL_MS;
  let target = boundary + TICK_OFFSET_MS;
  if (target - now < 5000) target += TICK_INTERVAL_MS;
  return target - now;
}

function scheduleNext(): void {
  if (!status.running) return;
  const delay = nextTickDelay(Date.now());
  status.nextTickAt = Date.now() + delay;
  timer = setTimeout(() => {
    void runTick().finally(scheduleNext);
  }, delay);
}

/** 엔진 시작 — 서버 부팅 시 1회 호출. 봉 경계에 맞춰 자기 재예약한다. */
export function startAutoTradeEngine(): void {
  if (status.running) return;
  status.running = true;
  scheduleNext();
  guardTimer = setInterval(() => void runGuardTick(), GUARD_TICK_INTERVAL_MS);
  pulseTimer = setInterval(() => void runPulseTick(), PULSE_INTERVAL_MS);
  console.log(
    '[auto-trade] 백그라운드 엔진 시작(드라이런) — 5분봉 AI 판단 + 1분 보호 틱 + 20초 변동 펄스(±0.3% 즉시 재판단, 공격 배수 ' +
      `${PAPER_AGGRESSION_MULT}×)`
  );
}

export function stopAutoTradeEngine(): void {
  status.running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (guardTimer) {
    clearInterval(guardTimer);
    guardTimer = null;
  }
  if (pulseTimer) {
    clearInterval(pulseTimer);
    pulseTimer = null;
  }
  status.nextTickAt = null;
}

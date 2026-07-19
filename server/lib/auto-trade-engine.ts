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
}

let timer: ReturnType<typeof setTimeout> | null = null;
let ticking = false;
let logSeq = 0;
const logs: AutoLogEntry[] = [];

const status: Omit<AutoEngineStatus, 'paper'> = {
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
  return { ...status, ticking, paper: getPaperSummaries() };
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
  candles: AiDecisionCandle[]
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

  // 2-b) 목표 도달: 상승 추세면 홀드 시작, 아니면 즉시 익절.
  if (currentPrice >= tpPrice) {
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

  // 3) 판단 컨텍스트는 페이퍼 장부 기준 — 가상 $1,000 에서 0 부터 시작하는 실험.
  //    (markPaperPrice 가 장부 항목을 생성/평가가 갱신해 요약이 항상 존재하게 한다)
  markPaperPrice(symbol, currentPrice);

  // 기계적 보호 로직(손절/익절+추세홀드/트레일링) — AI 판단에 앞서 코드가 강제한다.
  const guardPos = getPaperSummary(symbol);
  const guard = runPaperGuards(symCfg, currentPrice, candles);
  if (guard?.handled) {
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
      buyMaxPercent: symCfg.buyMaxPercent,
      dailyLossLimitUsd: config.dailyLossLimitUsd > 0 ? config.dailyLossLimitUsd : undefined,
    },
    candles,
  };

  const decision = await getAiTradeDecision(request);

  // 페이퍼 체결 — 가상 $1,000 장부에 반영. 매수는 종목 설정의 1회 매수 상한을 그대로 적용해
  // 실주문 모드가 했을 비중과 동일하게 시뮬레이션한다. HOLD/폴백은 평가 가격만 갱신(위에서 완료).
  let paperFill: PaperFill | null = null;
  if (!decision.fallback && decision.action !== 'HOLD') {
    const paperPct =
      decision.action === 'BUY' ? Math.min(decision.sizePct, symCfg.buyMaxPercent) : decision.sizePct;
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
  console.log('[auto-trade] 백그라운드 엔진 시작(드라이런) — 열린 세션 동안 5분봉마다 페이퍼 장부로 판단');
}

export function stopAutoTradeEngine(): void {
  status.running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  status.nextTickAt = null;
}

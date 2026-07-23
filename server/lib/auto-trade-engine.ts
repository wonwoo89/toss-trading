import {
  AUTO_CANDLE_INTERVAL,
  getAutoTradeConfig,
  saveAutoTradeConfig,
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
  resyncBgLiveToAccount,
  runBgLiveGuards,
  sellAllBgLive,
  syncPositionFromAccount,
  type BgLiveSummary,
} from './bg-live.js';
import { aggregateCandles, getRequiredSourceCount, type AggregatedCandle } from './candle-aggregate.js';
import { computeAtr, computeRegime, computeSignal, computeTrend } from './candle-signals.js';
import { fetchSourceCandles } from './fetch-source-candles.js';
import { fetchMarketRef } from './live-trader.js';
import {
  applyPaperDecision,
  getPaperSummaries,
  getPaperSummary,
  markPaperPrice,
  resetPaperPortfolio,
  updatePaperTracking,
  PAPER_COMMISSION_RATE,
  type PaperFill,
  type PaperSummary,
} from './paper-portfolio.js';
import { tossRequest } from './toss-client.js';
import {
  getUsMarketSession,
  isFractionalOrderTime,
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

// ── 변동성(ATR) 동적 목표/손절(5분 틱 기준) — config.atrLevels 켠 경우 ──
// 단일 종목 트레이더와 동일 튜닝값. 백그라운드는 캔들을 5분 full 틱에서만 받으므로
// 레벨 갱신도 5분 단위 — 1분 보호 틱·펄스는 마지막 채택 레벨을 재사용한다.
/** 손절 거리 = ATR × 이 배수. 각 종목 설정 손절률을 넘지 않음(더 타이트해질 수만 있음). */
const ATR_STOP_MULT = 1.5;
/** 목표 거리 = ATR × 이 배수. */
const ATR_TP_MULT = 2.0;
/** ATR 모드 목표 하한(%) — 왕복 수수료를 빼고도 수익이 남는 최소선. */
const ATR_TP_MIN_PCT = 0.5;
/** 레벨 재채택 데드밴드(%p) — 이 미만의 잔변동은 무시해 갱신 로그 스팸을 막는다. */
const DYN_LEVEL_DEADBAND_PCT = 0.15;
/** 종목별 채택된 동적 레벨 — full 틱이 계산, 보호 틱이 재사용. 재시작 시 초기화. */
const dynLevels = new Map<string, { targetPct: number; stopPct: number }>();

/** ATR 모드면 full 틱이 채택해 둔 동적 목표/손절로 덮어쓴 설정 사본을 반환. */
function withAtrLevels(symCfg: AutoSymbolConfig, config: AutoTradeConfig): AutoSymbolConfig {
  if (!config.atrLevels) return symCfg;
  const dyn = dynLevels.get(symCfg.symbol);
  if (!dyn) return symCfg;
  return { ...symCfg, targetPercent: dyn.targetPct, stopLossPercent: dyn.stopPct };
}

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

// ── 판단 피드백 루프(단일 종목 트레이더와 동일) ─────────────────────
// 종목별 AI 판단 이력(메모리) — 판단 시점 가격과 이후 변동률(적중 피드백)을 프롬프트에 제공해
// 모델이 자기 판단을 교정하게 한다. 재시작 시 초기화(다음 판단부터 다시 누적).
interface BgAiHistoryEntry {
  t: number;
  action: AiAction;
  confidence: number;
  executed: boolean;
  reason: string;
  priceAtDecision: number;
}
const MAX_BG_AI_HISTORY = 10;
const aiHistories = new Map<string, BgAiHistoryEntry[]>();

function pushAiHistory(symbol: string, entry: BgAiHistoryEntry): void {
  const list = aiHistories.get(symbol) ?? [];
  list.unshift(entry);
  aiHistories.set(symbol, list.slice(0, MAX_BG_AI_HISTORY));
}

function buildAiHistory(symbol: string, currentPrice: number): AiDecisionRequest['history'] {
  const list = aiHistories.get(symbol);
  if (!list?.length) return undefined;
  return list.slice(0, 8).map((h) => ({
    t: h.t,
    action: h.action,
    confidence: h.confidence,
    executed: h.executed,
    reason: h.reason.slice(0, 100),
    priceAtDecision: h.priceAtDecision,
    moveSincePct:
      h.priceAtDecision > 0 ? ((currentPrice - h.priceAtDecision) / h.priceAtDecision) * 100 : undefined,
  }));
}

// ── 데이터 품질 가드(단일 종목 트레이더와 동일 기준) ─────────────────
/** 최근 캔들이 이보다 오래됐으면(시세 지연·거래정지 의심) AI 판단을 보류한다. */
const STALE_CANDLE_MAX_MIN = 20;
/** 실거래 매수 억제 스프레드 상한(%) — 유동성 부족·슬리피지 위험. */
const MAX_SPREAD_PCT = 1.0;
/** 품질/사전 필터 로그 과다 방지 — 종목별 마지막 로그 시각. */
const lastQualityLogAt = new Map<string, number>();
const lastSkipLogAt = new Map<string, number>();

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

/**
 * 엔진 초기화 — 판단 로그를 비우고, 종목별 장부를 새로 시작한다.
 *  - 페이퍼: 가상 $1,000 로 리셋.
 *  - 실거래: 실계좌 보유로 재동기화(실제 평단 물려받아 관리 지속, 실현·미체결 기록 비움).
 * 재시작마다 자동이 아니라 사용자가 명시적으로 호출(POST /api/auto/reset)한다.
 */
export async function resetAutoEngine(): Promise<{ paper: number; live: number; liveFailed: string[] }> {
  logs.length = 0;
  logSeq = 0;
  lastAiJudgment.clear();
  aiHistories.clear();
  lastQualityLogAt.clear();
  lastSkipLogAt.clear();

  const config = getAutoTradeConfig();
  const liveSymbols = config.symbols.filter((s) => s.live);
  const paperSymbols = config.symbols.filter((s) => !s.live).map((s) => s.symbol);

  // 페이퍼: 등록 종목 장부 삭제 → 다음 틱에 $1,000 로 재생성.
  resetPaperPortfolio(paperSymbols);

  // 실거래: 각 풀을 실계좌 보유로 재동기화(계좌 조회 실패 종목은 건드리지 않음).
  const liveFailed: string[] = [];
  for (const s of liveSymbols) {
    const ok = await resyncBgLiveToAccount(s.symbol, s.poolUsd);
    if (!ok) liveFailed.push(s.symbol);
  }

  pushLog({
    t: Date.now(),
    symbol: '-',
    session: 'unknown',
    action: 'HOLD',
    sizePct: 0,
    confidence: 0,
    reason: `엔진 초기화 — 페이퍼 ${paperSymbols.length}종목 리셋, 실거래 ${liveSymbols.length - liveFailed.length}종목 실계좌 재동기화${liveFailed.length ? ` (조회 실패 ${liveFailed.join(',')})` : ''}`,
    fallback: false,
    currentPrice: 0,
    model: 'reset',
  });

  return { paper: paperSymbols.length, live: liveSymbols.length - liveFailed.length, liveFailed };
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
  regime: ReturnType<typeof computeRegime>;
  marketRef: Awaited<ReturnType<typeof fetchMarketRef>>;
  /** 최근 캔들 경과(분) — 데이터 품질 가드. */
  candleAgeMin: number;
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
  const { candles, currentPrice, currency, bids, asks, bidTotal, askTotal, signal, trend, regime, marketRef, candleAgeMin } = ctx;
  // 소수점 매도가능 수량은 소수점 주문 가능 시간대(정규장 + KST 04시 이전)에만.
  const canFractional = session === 'regular' && isFractionalOrderTime();

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

  // 0) 실계좌 포지션 동기화(단일 진실) — 수량·평단·가용예산을 실계좌 기준으로 맞춘다.
  const syncNote = await syncPositionFromAccount(symbol, symCfg.poolUsd);
  if (syncNote) liveLog('HOLD', `[실거래] ${syncNote}`, 'live-reconcile');
  // 0-b) 미체결 대조 — 체결 확정/취소/재호가(API·추적만, 포지션은 위 동기화가 담당).
  for (const note of await reconcileBgOrders(symbol, currentPrice, { bestBid: bids[0]?.p, bestAsk: asks[0]?.p })) {
    liveLog('HOLD', note, 'live-order');
  }

  // 1) 보호 가드(실매도) — 발화 시 이번 틱 AI 생략.
  const guard = await runBgLiveGuards(symCfg, currentPrice, candles, session, 'full');
  if (guard) {
    liveLog(guard.sold ? 'SELL' : 'HOLD', `[실거래] ${guard.reason}`, 'live-guard', {
      sizePct: guard.sold ? 100 : 0,
    });
    if (guard.forcedOff) liveLog('HOLD', '일일 손실 한도 도달 — 백그라운드 엔진 전역 OFF', 'live-guard');
    if (guard.circuitOff)
      liveLog('HOLD', `[실거래] 서킷 브레이커: 연속 손실 — ${symbol} 종목 자동 정지(설정 재검토 권장)`, 'live-guard');
    if (guard.handled) return;
  }

  // 1-b) 데이터 품질 가드 — 캔들이 오래됐으면(시세 지연·거래정지) AI 신규 판단만 보류.
  //      보호 매도(위)는 이미 수행됨.
  if (candleAgeMin > STALE_CANDLE_MAX_MIN) {
    if (Date.now() - (lastQualityLogAt.get(symbol) ?? 0) > 10 * 60 * 1000) {
      lastQualityLogAt.set(symbol, Date.now());
      liveLog('HOLD', `[실거래] 데이터 품질: 최근 캔들이 ${Math.round(candleAgeMin)}분 전 — AI 판단 보류`, 'quality');
    }
    return;
  }

  // 1-b2) 매수 불가 사전 필터 — 무포지션 + 소수점 불가 시간대 + 풀 현금 < 1주면
  //       실행 가능한 매수가 없으므로 AI 호출을 생략한다(의견→차단 반복 방지).
  if (pool.quantity <= 0 && currentPrice > 0 && !canFractional && pool.cash < currentPrice) {
    if (Date.now() - (lastSkipLogAt.get(symbol) ?? 0) > 30 * 60 * 1000) {
      lastSkipLogAt.set(symbol, Date.now());
      liveLog(
        'HOLD',
        `[실거래] AI 판단 생략(매수 불가 상태): 풀 현금 $${pool.cash.toFixed(2)} < 1주 $${currentPrice.toFixed(2)} · 소수점 주문 불가 시간대`,
        'skip'
      );
    }
    return;
  }

  // 1-c) 티어드 사전 필터(실거래 전용) — 무포지션 + 신호 완전 중립 + 미세 변동이면
  //      AI 호출 생략(비용·노이즈 절감). 기준가는 갱신하지 않아 다음 유의미 변동에서 즉시 판단.
  //      (페이퍼는 드라이런 표본 확보가 목적이라 필터를 적용하지 않는다)
  if (pool.quantity <= 0) {
    const last = lastAiJudgment.get(symbol);
    const flatSignal =
      Math.abs(signal.score) <= 0.5 && (signal.rsi === undefined || (signal.rsi > 45 && signal.rsi < 55));
    const microMove =
      last !== undefined && last.price > 0 && (Math.abs(currentPrice - last.price) / last.price) * 100 < 0.15;
    if (flatSignal && trend.state !== 'up' && microMove) {
      if (Date.now() - (lastSkipLogAt.get(symbol) ?? 0) > 30 * 60 * 1000) {
        lastSkipLogAt.set(symbol, Date.now());
        liveLog('HOLD', `[실거래] AI 호출 생략(사전 필터): 무포지션 · 신호 중립(score ${signal.score}) · 변동 미미`, 'skip');
      }
      return;
    }
  }

  // 2) AI 판단 — 컨텍스트는 풀 장부 기준.
  const sellableQty = canFractional ? pool.quantity : Math.floor(pool.quantity);
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
    regime: { adx: regime.adx, state: regime.state },
    marketRef,
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
    history: buildAiHistory(symbol, currentPrice),
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
  if (!decision.fallback) {
    pushAiHistory(symbol, {
      t: Date.now(),
      action: decision.action,
      confidence: decision.confidence,
      executed: false,
      reason: decision.reason,
      priceAtDecision: currentPrice,
    });
  }
  const markExecuted = () => {
    const h = aiHistories.get(symbol)?.[0];
    if (h) h.executed = true;
  };

  if (decision.fallback || decision.action === 'HOLD') return;
  if (decision.action === 'BUY') {
    // 같은 방향 미체결이 있으면 중복 진입 방지(미체결 취소 후 다음 판단에서 재시도).
    if (getBgLive(symbol)?.openOrders.some((o) => o.side === 'BUY')) {
      liveLog('HOLD', '[실거래] 매수 보류 — 미체결 매수 주문 존재', 'live-exec');
      return;
    }
    // 데이터 품질 가드 — 스프레드가 넓으면(유동성 부족·슬리피지 위험) 신규 매수 억제.
    const bestBid = bids[0]?.p;
    const bestAsk = asks[0]?.p;
    if (bestBid !== undefined && bestAsk !== undefined && bestBid > 0) {
      const spreadPct = ((bestAsk - bestBid) / bestBid) * 100;
      if (spreadPct > MAX_SPREAD_PCT) {
        liveLog('HOLD', `[실거래] AI 매수 보류 — 스프레드 ${spreadPct.toFixed(2)}% > ${MAX_SPREAD_PCT}%(유동성 부족)`, 'quality');
        return;
      }
    }
    const res = await executeBgLiveBuy(
      symCfg,
      { price: currentPrice, bestAsk: asks[0]?.p },
      session,
      decision.sizePct,
      decision.reason
    );
    if (res.ok) markExecuted();
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
    if (res.ok) markExecuted();
    liveLog(res.ok ? 'SELL' : 'HOLD', `[실거래] ${res.text}`, 'live-exec', { sizePct: 100 });
    if (res.forcedOff) liveLog('HOLD', '일일 손실 한도 도달 — 백그라운드 엔진 전역 OFF', 'live-exec');
    if (res.circuitOff)
      liveLog('HOLD', `[실거래] 서킷 브레이커: 연속 손실 — ${symbol} 종목 자동 정지(설정 재검토 권장)`, 'live-exec');
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
  // 시장 국면(ADX) + 시장 맥락(QQQ, 60초 캐시 — 다종목이 한 조회를 공유).
  const regime = computeRegime(candles);
  const marketRef = await fetchMarketRef();
  const candleAgeMin = (Date.now() / 1000 - candles[candles.length - 1].t) / 60;

  // 변동성(ATR) 동적 목표/손절 갱신(5분 틱 기준) — 장기 ATR14·단기 ATR5 중 큰 값.
  // 데드밴드(0.15%p) 이상 변할 때만 재채택해 로그 스팸을 막는다.
  if (config.atrLevels && currentPrice > 0) {
    const atr14 = signal.atr ?? 0;
    const atrFast = computeAtr(candles, 5) ?? 0;
    const atrEff = Math.max(atr14, atrFast);
    if (atrEff > 0) {
      const atrPct = (atrEff / currentPrice) * 100;
      const dynT =
        Math.round(Math.min(Math.max(atrPct * ATR_TP_MULT, ATR_TP_MIN_PCT), symCfg.targetPercent * 3) * 100) / 100;
      const dynS =
        Math.round(Math.min(Math.max(atrPct * ATR_STOP_MULT, 0.5), symCfg.stopLossPercent) * 100) / 100;
      const prev = dynLevels.get(symbol);
      if (
        !prev ||
        Math.abs(prev.targetPct - dynT) >= DYN_LEVEL_DEADBAND_PCT ||
        Math.abs(prev.stopPct - dynS) >= DYN_LEVEL_DEADBAND_PCT
      ) {
        dynLevels.set(symbol, { targetPct: dynT, stopPct: dynS });
        pushLog({
          t: Date.now(),
          symbol,
          session,
          action: 'HOLD',
          sizePct: 0,
          confidence: 1,
          reason: `ATR 동적 레벨 갱신: 목표 +${dynT}% / 손절 -${dynS}% (5분봉 ATR ${atrPct.toFixed(2)}%)`,
          fallback: false,
          currentPrice,
          model: 'atr',
        });
      }
    }
  }
  // 이하 가드·AI 컨텍스트는 ATR 모드면 동적 레벨이 덮어쓴 설정 사본을 쓴다.
  const effCfg = withAtrLevels(symCfg, config);

  // ── 실거래(3단계) 분기 — 배정 풀 장부 기준으로 실제 주문 ──
  if (symCfg.live) {
    await evaluateSymbolLive(effCfg, config, session, {
      candles,
      currentPrice,
      currency,
      bids,
      asks,
      bidTotal,
      askTotal,
      signal,
      trend,
      regime,
      marketRef,
      candleAgeMin,
    });
    return;
  }

  // 3) 판단 컨텍스트는 페이퍼 장부 기준 — 가상 $1,000 에서 0 부터 시작하는 실험.
  //    (markPaperPrice 가 장부 항목을 생성/평가가 갱신해 요약이 항상 존재하게 한다)
  markPaperPrice(symbol, currentPrice);

  // 기계적 보호 로직(손절/익절+추세홀드/트레일링) — AI 판단에 앞서 코드가 강제한다.
  const guardPos = getPaperSummary(symbol);
  const guard = runPaperGuards(effCfg, currentPrice, candles);
  if (guard?.handled) {
    logGuardOutcome(symbol, session, currentPrice, guardPos, guard);
    return; // 이번 틱은 보호 로직이 처리 — AI 호출 생략(다음 틱부터 재개)
  }

  // 데이터 품질 가드 — 캔들이 오래됐으면(시세 지연·거래정지) AI 판단만 보류(보호 매도는 위에서 수행).
  if (candleAgeMin > STALE_CANDLE_MAX_MIN) {
    if (Date.now() - (lastQualityLogAt.get(symbol) ?? 0) > 10 * 60 * 1000) {
      lastQualityLogAt.set(symbol, Date.now());
      pushLog({
        t: Date.now(),
        symbol,
        session,
        action: 'HOLD',
        sizePct: 0,
        confidence: 1,
        reason: `데이터 품질: 최근 캔들이 ${Math.round(candleAgeMin)}분 전 — 시세 지연/거래정지 의심, AI 판단 보류`,
        fallback: false,
        currentPrice,
        model: 'quality',
      });
    }
    return;
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
    targetProfitPct: effCfg.targetPercent,
    stopLossPct: effCfg.stopLossPercent,
    signal: { level: signal.level, score: signal.score, rsi: signal.rsi, sma20: signal.sma20, sma50: signal.sma50, atr: signal.atr },
    regime: { adx: regime.adx, state: regime.state },
    marketRef,
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
    history: buildAiHistory(symbol, currentPrice),
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
  // 판단 피드백 이력 — 다음 판단에서 '이후 변동률'로 적중 여부를 되먹인다.
  if (!decision.fallback) {
    pushAiHistory(symbol, {
      t: Date.now(),
      action: decision.action,
      confidence: decision.confidence,
      executed: Boolean(paperFill),
      reason: decision.reason,
      priceAtDecision: currentPrice,
    });
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
  // 판단이 길어지는 동안 nextTickAt 이 지난 예약 시각(=방금 시작한 시각)으로 남아
  // '다음 판단'이 '마지막 확인'과 같게 보이던 문제 — 시작 즉시 다음 봉 기준 예상치로 갱신.
  // (틱 종료 후 scheduleNext 가 정확한 값으로 다시 계산한다)
  if (status.running) status.nextTickAt = status.lastTickAt + nextTickDelay(status.lastTickAt);

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

// ── 04시(KST) 일일 전체 셧다운 — 소수점 주문 불가 시간대 진입 시 1차 안전 정지.
//    재시작은 사용자가 수동으로 판단한다. 하루 1회만 발화(수동 재시작을 다시 끄지 않음).
let lastDailyShutdownDay: string | null = null;
function checkDailyShutdown(): void {
  const config = getAutoTradeConfig();
  if (!config.enabled) return;
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  if (kst.getUTCHours() !== 4) return;
  const day = kst.toISOString().slice(0, 10);
  if (lastDailyShutdownDay === day) return;
  lastDailyShutdownDay = day;
  saveAutoTradeConfig({ ...config, enabled: false });
  status.enabled = false;
  pushLog({
    t: Date.now(),
    symbol: 'SYSTEM',
    session: 'regular',
    action: 'HOLD',
    sizePct: 0,
    confidence: 1,
    reason: '04시(KST) 일일 셧다운 — 소수점 주문 불가 시간대 진입, 백그라운드 엔진 전역 OFF(재시작은 수동)',
    fallback: false,
    currentPrice: 0,
    model: 'system',
  });
}

async function runGuardTick(): Promise<void> {
  if (guardTicking) return;
  checkDailyShutdown();
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
        // 실거래: 실계좌 동기화 + 미체결 취소 + 하락 보호(실매도). 로그는 pushLog 로 남긴다.
        markBgLivePrice(symCfg.symbol, price);
        const syncNote = await syncPositionFromAccount(symCfg.symbol, symCfg.poolUsd);
        const notes = await reconcileBgOrders(symCfg.symbol, price);
        // ATR 모드면 5분 틱이 채택해 둔 동적 레벨로 보호 판정.
        const guard = await runBgLiveGuards(withAtrLevels(symCfg, config), price, [], session, 'protect');
        const entries: { action: AiAction; reason: string; model: string }[] = [
          ...(syncNote ? [{ action: 'HOLD' as AiAction, reason: `[실거래] ${syncNote}`, model: 'live-reconcile' }] : []),
          ...notes.map((n) => ({ action: 'HOLD' as AiAction, reason: n, model: 'live-order' })),
          ...(guard
            ? [{ action: (guard.sold ? 'SELL' : 'HOLD') as AiAction, reason: `[실거래] ${guard.reason}`, model: 'live-guard' }]
            : []),
          ...(guard?.forcedOff
            ? [{ action: 'HOLD' as AiAction, reason: '일일 손실 한도 도달 — 백그라운드 엔진 전역 OFF', model: 'live-guard' }]
            : []),
          ...(guard?.circuitOff
            ? [{ action: 'HOLD' as AiAction, reason: `[실거래] 서킷 브레이커: 연속 손실 — ${symCfg.symbol} 종목 자동 정지(설정 재검토 권장)`, model: 'live-guard' }]
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
      const guard = runPaperGuards(withAtrLevels(symCfg, config), price, [], 'protect');
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

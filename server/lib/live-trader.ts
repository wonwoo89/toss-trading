import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getAiTradeDecision,
  isAiConfigured,
  type AiDecisionCandle,
  type AiDecisionRequest,
} from './ai-decision.js';
import { aggregateCandles, getRequiredSourceCount, type AggregatedCandle } from './candle-aggregate.js';
import { computeAtr, computeRegime, computeSignal, computeTrend } from './candle-signals.js';
import { fetchSourceCandles } from './fetch-source-candles.js';
import { getDefaultAccountSeq, tossRequest } from './toss-client.js';
import {
  getUsMarketSession,
  isFractionalOrderTime,
  isTradeableSession,
  type UsMarketSessionKind,
} from './us-market-session.js';

/** 소수점 주문 가능 여부 — 정규장 세션 + KST 04시 이전 소수점 접수 시간대일 때만. */
function fractionalAllowed(session: UsMarketSessionKind): boolean {
  return session === 'regular' && isFractionalOrderTime();
}

/**
 * 포어그라운드(라이브) AI 트레이더 — 클라이언트 'AI 매매' 모드의 서버 이관.
 *
 * 브라우저 대신 서버가 단일 종목을 주시하며 실제 주문을 낸다. 아이폰/아이패드 등
 * 어느 기기에서 봐도 같은 상태(설정·로그·포지션)를 공유한다.
 *
 * 백그라운드(페이퍼) 엔진과의 구분:
 *  - 이쪽은 "한 번에 한 종목" + "실주문". 페이퍼 엔진은 다종목 + 가상 체결로 병행 유지.
 *  - 판단 주기: 5분봉 마감(+오프셋) AI 판단 + 1분 보호 틱(손절/보전선/트레일링, AI 없음)
 *    + 20초 가격 펄스 — 마지막 AI 판단가 대비 ±0.3% 이상 변동 시 즉시 AI 판단(클라이언트
 *    AI 매매의 AI_PRICE_MOVE_PCT/AI_MIN_INTERVAL_MS 트리거와 동일 규칙).
 *
 * 클라이언트 AI 매매와 동일한 규칙을 서버에서 강제한다:
 *  - 체결 우선 지정가(상대 호가 ±0.1%, 판단가 ±0.5% 캡), 미체결 자동 취소(90s+0.2%),
 *  - 소수점 규칙(정규장: 소수점 전량 시장가 매도/금액 매수, 비정규장: 정수 + 1주 폴백),
 *  - 익절+추세 홀드(보전선/고점 트레일), 손절/트레일링, 쿨다운 30s,
 *  - 일일 실현 손실 한도 도달 시 강제 OFF(영속).
 */

const TICK_INTERVAL_MS = 5 * 60 * 1000;
const TICK_OFFSET_MS = 20 * 1000;
const GUARD_TICK_INTERVAL_MS = 60 * 1000;
// 클라이언트 AI 매매와 동일한 즉각 판단 트리거 — 봉 마감 외에 의미있는 가격 변동 시 추가 호출.
const AI_MIN_INTERVAL_MS = 20_000;
const AI_PRICE_MOVE_PCT = 0.3;
const PULSE_INTERVAL_MS = 20_000;
const CANDLE_TARGET = 60;
const CANDLE_INTERVAL = '5m' as const;
const MAX_LOGS = 80;
const MAX_AI_HISTORY = 10;
const COOLDOWN_MS = 30_000;
const CROSS_BUFFER_PCT = 0.1;
const MAX_CHASE_PCT = 0.5;
const TP_HOLD_TRAIL_PCT = 0.5;
const STALE_UNFILLED_MS = 90_000;
const STALE_PRICE_AWAY_PCT = 0.2;
/** 익절 목표가 수수료(편도) 가정 — 왕복 반영해 목표 실수익을 보전. */
const COMMISSION_RATE = 0.001;
// ── 변동성(ATR) 동적 목표/손절 — useAtrLevels 켠 경우 ──
/** 손절 거리 = ATR × 이 배수. 사용자 손절률을 넘지 않는 범위에서 적용(더 타이트해질 수만 있음). */
const ATR_STOP_MULT = 1.5;
/** 목표 거리 = ATR × 이 배수. 저변동 구간 회전을 위해 하한은 설정값이 아니라 ATR_TP_MIN_PCT. */
const ATR_TP_MULT = 2.0;
/** ATR 모드 목표 하한(%) — 왕복 수수료(0.2%)를 빼고도 수익이 남는 최소선.
 *  목표가 설정값 아래로 내려가는 건 '더 일찍 익절'이라 리스크를 늘리지 않는다. */
const ATR_TP_MIN_PCT = 0.5;
/** 동적 레벨 데드밴드(%p) — 목표/손절이 마지막 채택값 대비 이 이상 움직일 때만 갱신.
 *  미세 변동(예: 목표 1.16→1.09%)마다 레벨·로그가 출렁이는 것을 막는다(최초 계산은 즉시 채택). */
const DYN_LEVEL_DEADBAND_PCT = 0.15;
/** 최신 반응형 ATR%(현재가 대비) — 펄스 임계 계산용. full 틱마다 갱신, 미확보 시 null. */
let lastAtrPct: number | null = null;

/** 펄스 임계(%) — 변동성 비례: 0.5×ATR%를 0.15~0.6%로 클램프.
 *  조용한 장에서는 0.15% 변동에도 즉시 판단(기민), 폭풍장에서는 노이즈 발화를 줄인다.
 *  ATR 미확보(첫 판단 전)면 기존 고정값(AI_PRICE_MOVE_PCT). */
function pulseThresholdPct(): number {
  if (lastAtrPct === null || !(lastAtrPct > 0)) return AI_PRICE_MOVE_PCT;
  return Math.min(0.6, Math.max(0.15, lastAtrPct * 0.5));
}
// ── 서킷 브레이커 ──
/** 연속 실현 손실 매도가 이 횟수에 도달하면 강제 OFF(재검토 유도). */
const CONSECUTIVE_LOSS_LIMIT = 3;
/** 실현 손실 직후 신규 매수 금지 시간(복수 매매 방지 쿨다운). */
const LOSS_COOLDOWN_MS = 5 * 60 * 1000;
// ── 데이터 품질 가드 ──
/** 최근 캔들이 이보다 오래됐으면(분) 시세 지연/거래정지로 보고 신규 판단 보류. */
const STALE_CANDLE_MAX_MIN = 20;
/** 호가 스프레드가 이보다 넓으면(%) 유동성 부족 — 신규 매수 억제. */
const MAX_SPREAD_PCT = 1.0;
let lastQualityLogAt = 0;
let lastSkipLogAt = 0;

export interface LiveTraderConfig {
  enabled: boolean;
  symbol: string;
  targetPercent: number;
  stopLossPercent: number;
  trailingStopPercent: number;
  buyMaxPercent: number;
  dailyLossLimitUsd: number;
  holdTpOnTrend: boolean;
  /** 변동성(ATR) 기반 동적 목표/손절 — 목표=clamp(2×ATR, 0.5%, 설정×3), 손절=min(설정, max(1.5×ATR, 0.5%)). */
  useAtrLevels: boolean;
}

export interface LiveLogEntry {
  id: number;
  t: number;
  level: 'trigger' | 'exec' | 'skip' | 'block' | 'error' | 'ai';
  side?: 'BUY' | 'SELL';
  text: string;
}

interface LiveTraderState {
  config: LiveTraderConfig;
  /** 활성화 시각 — 이후 접수 주문만 미체결 자동 취소 대상. */
  enabledAt: number | null;
  dailyDate: string;
  dailyRealizedUsd: number;
  tpHoldPeak: number | null;
  trailPeak: number | null;
  /** ATR 동적 목표/손절(%) — full 틱에서 계산·영속, 1분 보호 틱이 재사용. null=미계산. */
  dynTargetPct: number | null;
  dynStopPct: number | null;
  /** 연속 실현 손실 매도 횟수 — CONSECUTIVE_LOSS_LIMIT 도달 시 강제 OFF. */
  lossStreak: number;
  /** 에피소드(켠 이후) 매매 성과 — 매도 기준 승/패 집계. */
  stats: { sells: number; wins: number; losses: number };
  /** 마지막 실현 손실 시각 — 손실 직후 신규 매수 쿨다운. */
  lastLossAt: number | null;
  aiHistory: {
    t: number;
    action: string;
    confidence: number;
    executed: boolean;
    reason: string;
    /** 판단 시점 가격 — 이후 변동률(적중 피드백) 계산용. */
    priceAtDecision?: number;
  }[];
  logs: LiveLogEntry[];
  logSeq: number;
}

export interface LiveTraderStatus {
  config: LiveTraderConfig;
  running: boolean;
  ticking: boolean;
  session: UsMarketSessionKind | null;
  lastTickAt: number | null;
  nextTickAt: number | null;
  lastError: string | null;
  todayRealizedUsd: number;
  position: {
    quantity: number;
    averagePrice: number;
    currentPrice?: number;
    profitLossPct?: number;
  } | null;
  aiConfigured: boolean;
  /** 에피소드(켠 이후) 매매 성과 — 매도 기준. */
  stats: { sells: number; wins: number; losses: number };
  logs: LiveLogEntry[];
}

const DEFAULT_CONFIG: LiveTraderConfig = {
  enabled: false,
  symbol: '',
  targetPercent: 1,
  stopLossPercent: 3,
  trailingStopPercent: 0,
  buyMaxPercent: 5,
  dailyLossLimitUsd: 0,
  holdTpOnTrend: true,
  useAtrLevels: false,
};

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATA_DIR = path.join(rootDir, 'server', 'data');
const STORE_PATH = path.join(DATA_DIR, 'live-trader.json');

function kstDate(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

let state: LiveTraderState | null = null;

function defaultState(): LiveTraderState {
  return {
    config: { ...DEFAULT_CONFIG },
    enabledAt: null,
    dailyDate: kstDate(),
    dailyRealizedUsd: 0,
    tpHoldPeak: null,
    trailPeak: null,
    dynTargetPct: null,
    dynStopPct: null,
    lossStreak: 0,
    lastLossAt: null,
    stats: { sells: 0, wins: 0, losses: 0 },
    aiHistory: [],
    logs: [],
    logSeq: 0,
  };
}

function loadState(): LiveTraderState {
  if (state) return state;
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as Partial<LiveTraderState>;
    const base = defaultState();
    state = {
      ...base,
      ...raw,
      config: { ...base.config, ...(raw.config ?? {}) },
      stats:
        raw.stats && typeof raw.stats === 'object'
          ? {
              sells: Number(raw.stats.sells) || 0,
              wins: Number(raw.stats.wins) || 0,
              losses: Number(raw.stats.losses) || 0,
            }
          : { sells: 0, wins: 0, losses: 0 },
      logs: Array.isArray(raw.logs) ? raw.logs.slice(-MAX_LOGS) : [],
      aiHistory: Array.isArray(raw.aiHistory) ? raw.aiHistory.slice(0, MAX_AI_HISTORY) : [],
    };
  } catch {
    state = defaultState();
  }
  return state;
}

function saveState(): void {
  if (!state) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2), 'utf8');
  } catch (error) {
    console.error('[live] 상태 저장 실패:', error);
  }
}

function pushLog(level: LiveLogEntry['level'], text: string, side?: 'BUY' | 'SELL'): void {
  const s = loadState();
  s.logSeq += 1;
  s.logs.push({ id: s.logSeq, t: Date.now(), level, side, text });
  if (s.logs.length > MAX_LOGS) s.logs.splice(0, s.logs.length - MAX_LOGS);
  saveState();
}

/** 일일 원장 — KST 날짜가 바뀌면 리셋. */
function todayRealized(): number {
  const s = loadState();
  const today = kstDate();
  if (s.dailyDate !== today) {
    s.dailyDate = today;
    s.dailyRealizedUsd = 0;
    saveState();
  }
  return s.dailyRealizedUsd;
}

function addRealized(deltaUsd: number): number {
  const s = loadState();
  todayRealized();
  s.dailyRealizedUsd += deltaUsd;
  saveState();
  return s.dailyRealizedUsd;
}

export function sanitizeLiveConfig(raw: unknown): LiveTraderConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    enabled: r.enabled === true,
    symbol: typeof r.symbol === 'string' ? r.symbol.trim().toUpperCase() : '',
    targetPercent: clampNumber(r.targetPercent, 0.1, 100, DEFAULT_CONFIG.targetPercent),
    stopLossPercent: clampNumber(r.stopLossPercent, 0.1, 100, DEFAULT_CONFIG.stopLossPercent),
    trailingStopPercent: clampNumber(r.trailingStopPercent, 0, 100, 0),
    buyMaxPercent: clampNumber(r.buyMaxPercent, 0.1, 5, DEFAULT_CONFIG.buyMaxPercent),
    dailyLossLimitUsd: clampNumber(r.dailyLossLimitUsd, 0, 1_000_000, 0),
    holdTpOnTrend: r.holdTpOnTrend !== false,
    useAtrLevels: r.useAtrLevels === true,
  };
}

/** 설정 저장 — 켜기/끄기·종목 변경 시 에피소드 상태를 정리한다. */
export function saveLiveConfig(raw: unknown): LiveTraderConfig {
  const s = loadState();
  const next = sanitizeLiveConfig(raw);
  const prev = s.config;
  if (next.enabled && !next.symbol) next.enabled = false; // 종목 없는 켜기 방지

  const symbolChanged = next.symbol !== prev.symbol;
  const turnedOn = next.enabled && !prev.enabled;
  const turnedOff = !next.enabled && prev.enabled;

  s.config = next;
  if (turnedOn || (symbolChanged && next.enabled)) {
    // 즉각 판단 기준가 리셋 — 첫 판단(5분 틱)이 새 기준가를 세울 때까지 펄스 트리거는 쉼.
    aiLastPrice = null;
    aiLastCallAt = 0;
    lastAtrPct = null; // 종목이 바뀌면 이전 종목의 변동성 기준도 무효

    s.enabledAt = Date.now();
    s.tpHoldPeak = null;
    s.trailPeak = null;
    s.dynTargetPct = null;
    s.dynStopPct = null;
    s.lossStreak = 0;
    s.lastLossAt = null;
    s.stats = { sells: 0, wins: 0, losses: 0 };
    s.aiHistory = [];
    s.logs = [];
    s.logSeq = 0;
    saveState();
    pushLog('exec', `서버 AI 매매 시작: ${next.symbol} (목표 +${next.targetPercent}% / 손절 -${next.stopLossPercent}%)`);
  } else if (turnedOff) {
    s.enabledAt = null;
    saveState();
    pushLog('exec', '서버 AI 매매 정지(OFF)');
  } else {
    saveState();
  }
  return s.config;
}

// ── 계좌/시세 헬퍼 ────────────────────────────────────────────────

let cachedAccountSeq: string | null = null;
async function resolveAccountSeq(): Promise<string> {
  const fromEnv = getDefaultAccountSeq();
  if (fromEnv) return fromEnv;
  if (cachedAccountSeq) return cachedAccountSeq;
  const res = await tossRequest<{ result?: { accountSeq?: number | string }[] }>({
    path: '/api/v1/accounts',
  });
  const first = res.result?.[0]?.accountSeq;
  if (first === undefined || first === null || String(first) === '') {
    throw new Error('계좌를 찾지 못했습니다');
  }
  cachedAccountSeq = String(first);
  return cachedAccountSeq;
}

interface MarketCtx {
  currentPrice: number;
  currency: string;
  bids: { p: number; q: number }[];
  asks: { p: number; q: number }[];
}

async function fetchMarketCtx(symbol: string): Promise<MarketCtx> {
  const [priceRes, orderbookRes] = await Promise.all([
    tossRequest<{ result: { lastPrice?: string; currency?: string }[] }>({
      path: '/api/v1/prices',
      query: { symbols: symbol },
    }),
    tossRequest<{
      result: { bids?: { price: string; volume: string }[]; asks?: { price: string; volume: string }[] };
    }>({ path: '/api/v1/orderbook', query: { symbol } }),
  ]);
  const currentPrice = Number(priceRes.result?.[0]?.lastPrice);
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) throw new Error('현재가 없음');
  const map = (l: { price: string; volume: string }) => ({ p: Number(l.price), q: Number(l.volume) });
  return {
    currentPrice,
    currency: priceRes.result?.[0]?.currency ?? 'USD',
    bids: (orderbookRes.result?.bids ?? []).map(map),
    asks: (orderbookRes.result?.asks ?? []).map(map),
  };
}

interface AccountCtx {
  accountSeq: string;
  buyingPower?: number;
  holdingQty: number;
  averagePrice: number;
  /** 토스 보유 API 의 비용(수수료·세금) 반영 수익률(%) — 보유 종목 표시와 동일 기준. */
  profitLossPctAfterCost?: number;
  sellableQty?: number;
  openOrders: { orderId: string; side: 'BUY' | 'SELL'; orderType?: string; price?: number; quantity?: number; orderedAt?: string }[];
}

/** 포지션 수익률(%) — 비용 반영값(토스 제공)이 있으면 그것을, 없으면 총수익률 근사. */
function positionProfitLossPct(account: AccountCtx, currentPrice: number): number | undefined {
  if (account.profitLossPctAfterCost !== undefined) return account.profitLossPctAfterCost;
  if (account.averagePrice > 0 && currentPrice > 0) {
    return ((currentPrice - account.averagePrice) / account.averagePrice) * 100;
  }
  return undefined;
}

async function fetchAccountCtx(symbol: string): Promise<AccountCtx> {
  const accountSeq = await resolveAccountSeq();
  const [bpRes, holdingsRes, ordersRes, sellableRes] = await Promise.all([
    tossRequest<{ result: { cashBuyingPower?: string } }>({
      path: '/api/v1/buying-power',
      accountSeq,
      query: { currency: 'USD' },
    }),
    tossRequest<{
      result: {
        items?: {
          symbol: string;
          quantity: string;
          averagePurchasePrice: string;
          profitLoss?: { rate?: string; rateAfterCost?: string };
        }[];
      };
    }>({
      path: '/api/v1/holdings',
      accountSeq,
    }),
    tossRequest<{ result: { orders?: { orderId: string; side: 'BUY' | 'SELL'; orderType?: string; price?: string; quantity?: string; orderedAt?: string }[] } }>({
      path: '/api/v1/orders',
      accountSeq,
      query: { status: 'OPEN', symbol },
    }).catch(() => ({ result: { orders: [] as never[] } })),
    tossRequest<{ result: { sellableQuantity?: string } }>({
      path: '/api/v1/sellable-quantity',
      accountSeq,
      query: { symbol },
    }).catch(() => ({ result: {} as { sellableQuantity?: string } })),
  ]);
  const bp = Number(bpRes.result?.cashBuyingPower);
  const item = holdingsRes.result?.items?.find((h) => h.symbol.toUpperCase() === symbol);
  const sellable = Number(sellableRes.result?.sellableQuantity);
  // 비용(수수료·세금) 반영 수익률 — 보유 종목 카드와 동일하게 rateAfterCost 우선.
  const afterCost = Number(item?.profitLoss?.rateAfterCost ?? item?.profitLoss?.rate);
  return {
    accountSeq,
    buyingPower: Number.isFinite(bp) ? bp : undefined,
    holdingQty: item ? Number(item.quantity) : 0,
    averagePrice: item ? Number(item.averagePurchasePrice) : 0,
    profitLossPctAfterCost: Number.isFinite(afterCost) ? afterCost : undefined,
    sellableQty: Number.isFinite(sellable) ? sellable : undefined,
    openOrders: (ordersRes.result?.orders ?? []).map((o) => ({
      orderId: o.orderId,
      side: o.side,
      orderType: o.orderType,
      price: o.price !== undefined ? Number(o.price) : undefined,
      quantity: o.quantity !== undefined ? Number(o.quantity) : undefined,
      orderedAt: o.orderedAt,
    })),
  };
}

// ── 주문 헬퍼 ────────────────────────────────────────────────────

function floorTick(price: number): number {
  return Math.floor(price * 100) / 100;
}

function marketableBuyPrice(price: number, asks: MarketCtx['asks']): number {
  const ask = asks[0]?.p;
  const base = ask !== undefined && ask > 0 ? Math.max(ask, price) : price;
  return Math.min(base * (1 + CROSS_BUFFER_PCT / 100), price * (1 + MAX_CHASE_PCT / 100));
}

function marketableSellPrice(price: number, bids: MarketCtx['bids']): number {
  const bid = bids[0]?.p;
  const base = bid !== undefined && bid > 0 ? Math.min(bid, price) : price;
  return Math.max(base * (1 - CROSS_BUFFER_PCT / 100), price * (1 - MAX_CHASE_PCT / 100));
}

let lastExecAt = 0;

async function placeOrder(
  accountSeq: string,
  body: Record<string, unknown>
): Promise<{ ok: boolean; orderId?: string; error?: string }> {
  try {
    const res = await tossRequest<{ result?: { orderId?: string } }>({
      method: 'POST',
      path: '/api/v1/orders',
      accountSeq,
      body,
      retryOnRateLimit: false,
    });
    return { ok: true, orderId: res.result?.orderId };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '주문 실패' };
  }
}

/** 전량 매도(보호/AI 공통) — 세션별 소수점 규칙 + 체결 우선 가격. true=주문 접수됨. */
async function sellAll(
  ctx: { account: AccountCtx; market: MarketCtx; session: UsMarketSessionKind },
  label: string,
  /** 매도 비율(0<..<=1). 1=전량. 부분 익절(절반 확보 + 나머지 추세 연장)에 사용. */
  portion = 1
): Promise<boolean> {
  const s = loadState();
  const { account, market, session } = ctx;
  const canFractional = fractionalAllowed(session); // 정규장 + KST 04시 이전 소수점 접수 시간대
  // 소수점 주문 불가 시간대 + 보유 1주 미만(소수점 잔량) — 소수점 매도가 불가해 생략.
  // 정수 1주 이상은 정수부 매도가 가능하므로 막지 않는다.
  if (!canFractional && account.holdingQty < 1) {
    pushLog('block', `${label} 생략(보유 ${account.holdingQty}주 < 1주 — 소수점 잔량, 소수점 주문 불가 시간대)`, 'SELL');
    return false;
  }
  const base = account.sellableQty !== undefined && account.sellableQty > 0
    ? account.sellableQty
    : account.holdingQty;
  const scaled = base * Math.min(Math.max(portion, 0), 1);
  const qty = canFractional ? Math.floor(scaled * 1e8) / 1e8 : Math.floor(scaled);
  if (qty <= 0) {
    if (portion >= 1) pushLog('block', `${label} 생략(매도 가능 수량 없음)`, 'SELL');
    return false; // 부분 매도에서 0 이 되면(소수점 불가 시간대 1주 보유 등) 조용히 생략
  }
  if (Date.now() - lastExecAt < COOLDOWN_MS) {
    pushLog('block', `차단(쿨다운): ${label}`, 'SELL');
    return false;
  }
  const fractional = !Number.isInteger(qty);
  const body: Record<string, unknown> = {
    symbol: s.config.symbol,
    side: 'SELL',
    orderType: fractional ? 'MARKET' : 'LIMIT',
    quantity: qty,
    clientOrderId: `live-${Date.now()}`,
  };
  if (!fractional) body.price = floorTick(marketableSellPrice(market.currentPrice, market.bids));
  const result = await placeOrder(account.accountSeq, body);
  if (!result.ok) {
    pushLog('error', `${label} 주문 실패: ${result.error}`, 'SELL');
    return false;
  }
  lastExecAt = Date.now();
  pushLog('exec', `${label}: ${qty}주 @ ${fractional ? '시장가' : `$${body.price}`}`, 'SELL');

  // 실현 손익 근사(트리거가 기준) → 일일 한도·연속 손실 서킷 브레이커 판정.
  if (account.averagePrice > 0) {
    const realized = (market.currentPrice - account.averagePrice) * qty;
    const total = addRealized(realized);
    s.stats.sells += 1;
    if (realized < 0) {
      s.stats.losses += 1;
      s.lossStreak += 1;
      s.lastLossAt = Date.now(); // 손실 직후 신규 매수 쿨다운 기준
    } else if (realized > 0) {
      s.stats.wins += 1;
      s.lossStreak = 0;
    }
    saveState();
    const limit = s.config.dailyLossLimitUsd;
    if (limit > 0 && total <= -limit) {
      s.config.enabled = false;
      s.enabledAt = null;
      saveState();
      pushLog('block', `일일 손실 한도 도달($${total.toFixed(2)} ≤ -$${limit}) — 서버 AI 매매 강제 OFF`);
    } else if (s.lossStreak >= CONSECUTIVE_LOSS_LIMIT && s.config.enabled) {
      // 서킷 브레이커: 연속 손실 — 전략이 시장과 어긋난 신호. 강제 OFF 로 재검토 유도.
      s.config.enabled = false;
      s.enabledAt = null;
      saveState();
      pushLog('block', `서킷 브레이커: 연속 손실 ${s.lossStreak}회 — 서버 AI 매매 강제 OFF(설정 재검토 권장)`);
    }
  }
  // 전량 매도 시에만 포지션 종료 가정 → 에피소드 추적 상태 해제.
  // (부분 익절은 나머지 포지션의 홀드/트레일 추적을 이어간다)
  if (portion >= 1) {
    s.tpHoldPeak = null;
    s.trailPeak = null;
    saveState();
  }
  return true;
}

/** 유효 목표/손절(%) — ATR 모드면 full 틱이 계산해 둔 동적 레벨(없으면 설정값). */
function effectiveLevels(s: LiveTraderState): { targetPct: number; stopPct: number } {
  const cfg = s.config;
  if (!cfg.useAtrLevels) return { targetPct: cfg.targetPercent, stopPct: cfg.stopLossPercent };
  return {
    targetPct: s.dynTargetPct ?? cfg.targetPercent,
    stopPct: s.dynStopPct ?? cfg.stopLossPercent,
  };
}

// ── 보호 로직(실주문) — 페이퍼 가드와 동일 규칙 ──────────────────────

async function runProtectiveGuards(
  ctx: { account: AccountCtx; market: MarketCtx; session: UsMarketSessionKind },
  candles: AiDecisionCandle[],
  mode: 'full' | 'protect'
): Promise<boolean> {
  const s = loadState();
  const cfg = s.config;
  const { account, market } = ctx;
  if (account.holdingQty <= 0 || account.averagePrice <= 0) {
    if (s.tpHoldPeak !== null || s.trailPeak !== null) {
      s.tpHoldPeak = null;
      s.trailPeak = null;
      saveState();
    }
    return false;
  }

  const avg = account.averagePrice;
  const price = market.currentPrice;
  const plPct = ((price - avg) / avg) * 100;
  const r = COMMISSION_RATE;
  const eff = effectiveLevels(s); // ATR 모드면 동적 목표/손절
  const tpPrice = Math.ceil(((avg * (1 + eff.targetPct / 100 + r)) / (1 - r)) * 100 - 1e-9) / 100;
  const slPrice = avg * (1 - eff.stopPct / 100);

  const trailPeak = Math.max(s.trailPeak ?? Math.max(avg, price), price);
  if (trailPeak !== s.trailPeak) {
    s.trailPeak = trailPeak;
    saveState();
  }

  // 1) 손절 — 최우선.
  if (price <= slPrice) {
    return sellAll(ctx, `손절 매도(자동): 평단 $${avg.toFixed(2)} 대비 ${plPct.toFixed(2)}%`);
  }

  const holdTrailPct = cfg.trailingStopPercent > 0 ? cfg.trailingStopPercent : TP_HOLD_TRAIL_PCT;

  // 2-a) 추세 홀드 중 — 보전선/고점 트레일 이탈 시 매도.
  if (s.tpHoldPeak !== null) {
    const peak = Math.max(s.tpHoldPeak, price);
    if (peak !== s.tpHoldPeak) {
      s.tpHoldPeak = peak;
      saveState();
    }
    if (price <= tpPrice) {
      return sellAll(ctx, `익절 매도(추세홀드 종료): 보전선 $${tpPrice.toFixed(2)} 이탈`);
    }
    if (price <= peak * (1 - holdTrailPct / 100)) {
      return sellAll(ctx, `익절 매도(추세홀드 종료): 고점 $${peak.toFixed(2)} 대비 -${holdTrailPct}%`);
    }
    return false; // 홀드 유지 — AI 판단은 계속
  }

  // 2-b) 목표 도달 — 추세 확인은 5분(full) 틱 전용.
  if (mode === 'full' && price >= tpPrice) {
    const trend = computeTrend(candles);
    if (cfg.holdTpOnTrend && trend.state === 'up' && trend.confirmedBars >= 2) {
      // 부분 익절: 절반은 지금 확보(목표 수익 실현), 나머지는 고점 추적으로 추세 연장.
      // (수량이 부족해 절반 매도가 안 되면 — 예: 소수점 불가 시간대 1주 — 기존처럼 전량 홀드)
      const partialSold = await sellAll(
        ctx,
        `부분 익절(1/2 확보·추세 연장): 목표 +${eff.targetPct.toFixed(2)}% 도달, 상승 ${trend.confirmedBars}봉`,
        0.5
      );
      s.tpHoldPeak = price;
      saveState();
      pushLog(
        'skip',
        `${partialSold ? '나머지 절반' : '전량'} 추세홀드 — 고점 추적 시작, 보전선 $${tpPrice.toFixed(2)}`,
        'SELL'
      );
      return true; // 이번 틱은 홀드 진입으로 처리(AI 생략)
    }
    return sellAll(ctx, `익절 매도(자동): 목표 +${eff.targetPct.toFixed(2)}% 도달`);
  }

  // 3) 트레일링(설정 시).
  if (cfg.trailingStopPercent > 0 && price <= trailPeak * (1 - cfg.trailingStopPercent / 100)) {
    return sellAll(ctx, `트레일링 매도(자동): 고점 $${trailPeak.toFixed(2)} 대비 -${cfg.trailingStopPercent}%`);
  }

  return false;
}

/**
 * 미체결 처리 — 활성화 이후 접수된 지정가 주문이 90초+ 미체결이면:
 *  - 가격이 불리하게 0.2%+ 이탈(ranAway) → 취소만(다음 판단에서 재평가, 추격 금지).
 *  - 가격이 아직 부근(호가만 어긋나 안 잡힘) → 재호가: 취소 후 현재 체결 우선가로 재접수
 *    (특히 보호 매도가 미체결로 방치되지 않게). 재접수 주문도 90초 후 다시 이 로직을 탄다.
 */
async function cancelStaleOrders(ctx: {
  account: AccountCtx;
  market: MarketCtx;
}): Promise<void> {
  const s = loadState();
  const since = s.enabledAt;
  if (since === null) return;
  const now = Date.now();
  for (const order of ctx.account.openOrders) {
    if (order.orderType !== 'LIMIT' || order.price === undefined || order.price <= 0) continue;
    if (!order.orderedAt) continue;
    const orderedAtMs = new Date(order.orderedAt).getTime();
    if (!Number.isFinite(orderedAtMs) || orderedAtMs < since) continue;
    if (now - orderedAtMs < STALE_UNFILLED_MS) continue;
    const away = STALE_PRICE_AWAY_PCT / 100;
    const ranAway =
      order.side === 'BUY'
        ? ctx.market.currentPrice >= order.price * (1 + away)
        : ctx.market.currentPrice <= order.price * (1 - away);
    try {
      await tossRequest({
        method: 'POST',
        path: `/api/v1/orders/${order.orderId}/cancel`,
        accountSeq: ctx.account.accountSeq,
        body: {},
        retryOnRateLimit: false,
      });
    } catch (error) {
      pushLog('block', `미체결 취소 실패: ${error instanceof Error ? error.message : '오류'}`, order.side);
      continue;
    }

    if (ranAway) {
      pushLog(
        'exec',
        `미체결 취소: ${order.side === 'BUY' ? '매수' : '매도'} ${order.quantity ?? '-'}주 @ $${order.price} — 가격 이탈, 재판단`,
        order.side
      );
      continue;
    }

    // 재호가(cancel-and-replace): 같은 수량을 현재 체결 우선가로 재접수.
    const qty = order.quantity;
    if (qty === undefined || qty <= 0) continue;
    const newPrice =
      order.side === 'BUY'
        ? floorTick(marketableBuyPrice(ctx.market.currentPrice, ctx.market.asks))
        : floorTick(marketableSellPrice(ctx.market.currentPrice, ctx.market.bids));
    const result = await placeOrder(ctx.account.accountSeq, {
      symbol: s.config.symbol,
      side: order.side,
      orderType: 'LIMIT',
      quantity: qty,
      price: newPrice,
      clientOrderId: `live-${Date.now()}`,
    });
    if (result.ok) {
      pushLog(
        'exec',
        `재호가: ${order.side === 'BUY' ? '매수' : '매도'} ${qty}주 $${order.price} → $${newPrice} (90초 미체결, 체결 우선가로 갱신)`,
        order.side
      );
    } else {
      pushLog('error', `재호가 실패(${order.side} ${qty}주): ${result.error} — 다음 판단에서 재평가`, order.side);
    }
  }
}

// ── AI 판단 + 매수/매도 실행 ──────────────────────────────────────

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

/** 시장 맥락 — 지수 ETF(QQQ)의 최근 30분 흐름(1분봉 30개). 60초 캐시, 실패 시 undefined.
 *  백그라운드 엔진도 같은 캐시를 공유한다(다종목이어도 60초당 1회 조회). */
const MARKET_REF_SYMBOL = 'QQQ';
let marketRefCache: { t: number; data?: { symbol: string; movePct30m?: number; trendState?: string } } | null = null;

export async function fetchMarketRef(): Promise<{ symbol: string; movePct30m?: number; trendState?: string } | undefined> {
  if (marketRefCache && Date.now() - marketRefCache.t < 60_000) return marketRefCache.data;
  try {
    const source = await fetchSourceCandles({ symbol: MARKET_REF_SYMBOL, interval: '1m', count: 30, adjusted: true });
    const candles = source.candles.map(toAiCandle);
    if (candles.length < 5) throw new Error('표본 부족');
    const first = candles[0];
    const last = candles[candles.length - 1];
    const movePct30m = first.o > 0 ? ((last.c - first.o) / first.o) * 100 : undefined;
    const trend = computeTrend(candles);
    marketRefCache = { t: Date.now(), data: { symbol: MARKET_REF_SYMBOL, movePct30m, trendState: trend.state } };
  } catch {
    marketRefCache = { t: Date.now(), data: undefined }; // 실패도 캐시(과호출 방지)
  }
  return marketRefCache.data;
}

async function executeAiBuy(
  ctx: { account: AccountCtx; market: MarketCtx; session: UsMarketSessionKind },
  sizePct: number,
  reason: string
): Promise<void> {
  const s = loadState();
  const cfg = s.config;
  const { account, market, session } = ctx;
  if (!account.buyingPower || account.buyingPower <= 0) {
    pushLog('block', `AI 매수 보류 — 주문가능 없음: ${reason}`, 'BUY');
    return;
  }
  // 데이터 품질 가드: 스프레드가 넓으면(유동성 부족·슬리피지 위험) 신규 매수 억제.
  const bestBid = market.bids[0]?.p;
  const bestAsk = market.asks[0]?.p;
  if (bestBid !== undefined && bestAsk !== undefined && bestBid > 0) {
    const spreadPct = ((bestAsk - bestBid) / bestBid) * 100;
    if (spreadPct > MAX_SPREAD_PCT) {
      pushLog('block', `AI 매수 보류 — 스프레드 ${spreadPct.toFixed(2)}% > ${MAX_SPREAD_PCT}%(유동성 부족): ${reason}`, 'BUY');
      return;
    }
  }
  const limit = cfg.dailyLossLimitUsd;
  if (limit > 0 && todayRealized() <= -limit) {
    pushLog('block', `차단(일일 손실 한도 도달): AI 매수`, 'BUY');
    return;
  }
  // 손실 직후 쿨다운 — 복수 매매(연속 재진입) 방지.
  if (s.lastLossAt !== null && Date.now() - s.lastLossAt < LOSS_COOLDOWN_MS) {
    const waitMin = Math.ceil((LOSS_COOLDOWN_MS - (Date.now() - s.lastLossAt)) / 60000);
    pushLog('block', `차단(손실 직후 쿨다운 ${waitMin}분 남음): AI 매수 — ${reason.slice(0, 60)}`, 'BUY');
    return;
  }
  if (Date.now() - lastExecAt < COOLDOWN_MS) {
    pushLog('block', `차단(쿨다운): AI 매수`, 'BUY');
    return;
  }
  const effectivePct = sizePct > 0 ? Math.min(sizePct, cfg.buyMaxPercent) : cfg.buyMaxPercent;
  const budget = Math.floor(account.buyingPower * (effectivePct / 100) * 100) / 100;
  const price = market.currentPrice;
  const qty = Math.floor(budget / price);
  const canFractional = fractionalAllowed(session); // 정규장 + KST 04시 이전

  let body: Record<string, unknown>;
  let label: string;
  if (qty >= 1) {
    const exec = floorTick(marketableBuyPrice(price, market.asks));
    body = { symbol: cfg.symbol, side: 'BUY', orderType: 'LIMIT', quantity: qty, price: exec, clientOrderId: `live-${Date.now()}` };
    label = `AI 매수 ${qty}주(비중 ${effectivePct}%) @ $${exec}`;
  } else if (canFractional && budget >= 1) {
    body = { symbol: cfg.symbol, side: 'BUY', orderType: 'MARKET', orderAmount: budget, clientOrderId: `live-${Date.now()}` };
    label = `AI 소수점 매수 $${budget}(비중 ${effectivePct}%) 시장가`;
  } else if (price <= account.buyingPower * (cfg.buyMaxPercent / 100)) {
    const exec = floorTick(marketableBuyPrice(price, market.asks));
    body = { symbol: cfg.symbol, side: 'BUY', orderType: 'LIMIT', quantity: 1, price: exec, clientOrderId: `live-${Date.now()}` };
    label = `AI 매수 1주(비중 ${effectivePct}%→최소 수량) @ $${exec}`;
  } else {
    pushLog('block', `AI 매수 보류 — 배정 $${budget}로 1주($${price.toFixed(2)}) 미만: ${reason}`, 'BUY');
    return;
  }

  const result = await placeOrder(account.accountSeq, body);
  if (!result.ok) {
    pushLog('error', `AI 매수 주문 실패: ${result.error}`, 'BUY');
    return;
  }
  lastExecAt = Date.now();
  pushLog('exec', `${label} — ${reason}`, 'BUY');
  if (s.aiHistory[0]) {
    s.aiHistory[0].executed = true;
    saveState();
  }
}

// 즉각 판단 트리거 상태(메모리) — 마지막 AI 호출 시각·기준가. 클라이언트의
// aiLastCallRef/aiLastPriceRef 에 대응한다(재시작 시 리셋 = 다음 5분 틱이 기준가를 재설정).
let aiLastCallAt = 0;
let aiLastPrice: number | null = null;
let deciding = false;

async function decisionTick(): Promise<void> {
  if (deciding) return; // 5분 스케줄 틱과 펄스 트리거 틱의 중복 실행 방지
  deciding = true;
  try {
    await decisionTickInner();
  } finally {
    deciding = false;
  }
}

async function decisionTickInner(): Promise<void> {
  const s = loadState();
  status.lastTickAt = Date.now();
  status.aiConfigured = isAiConfigured();
  if (!s.config.enabled || !s.config.symbol) {
    status.session = null;
    return;
  }
  if (!isAiConfigured()) {
    status.lastError = 'AI 미설정';
    return;
  }
  const session = await getUsMarketSession();
  status.session = session;
  if (!isTradeableSession(session)) return;

  status.ticking = true;
  try {
    const symbol = s.config.symbol;
    const sourceCount = getRequiredSourceCount(CANDLE_INTERVAL, CANDLE_TARGET);
    const source = await fetchSourceCandles({ symbol, interval: '1m', count: sourceCount, adjusted: true });
    const aggregated = aggregateCandles(source.candles, CANDLE_INTERVAL).slice(-CANDLE_TARGET);
    if (aggregated.length < 2) throw new Error('캔들 부족');
    const candles = aggregated.map(toAiCandle);

    const [market, account] = await Promise.all([fetchMarketCtx(symbol), fetchAccountCtx(symbol)]);
    const ctx = { account, market, session };
    updatePositionCache(account, market);

    await cancelStaleOrders(ctx);

    // 보호 로직 우선 — 발화 시 이번 틱 AI 생략.
    if (await runProtectiveGuards(ctx, candles, 'full')) return;
    if (!loadState().config.enabled) return; // 한도 도달로 꺼졌을 수 있음

    // 데이터 품질 가드 — 캔들이 오래됐으면(거래정지·시세 지연) AI 판단 자체를 보류.
    // 보호 매도(위)는 이미 수행됨 — 낡은 데이터로 '신규 진입 판단'만 막는다.
    const lastCandleAgeMin = (Date.now() / 1000 - candles[candles.length - 1].t) / 60;
    if (lastCandleAgeMin > STALE_CANDLE_MAX_MIN) {
      if (Date.now() - lastQualityLogAt > 10 * 60 * 1000) {
        lastQualityLogAt = Date.now();
        pushLog('block', `데이터 품질: 최근 캔들이 ${Math.round(lastCandleAgeMin)}분 전 — 시세 지연/거래정지 의심, AI 판단 보류`);
      }
      return;
    }

    const signal = computeSignal(candles);
    const trend = computeTrend(candles);
    const regime = computeRegime(candles);
    const marketRef = await fetchMarketRef();

    // 반응형 ATR — 장기 ATR14(5분봉)·단기 ATR5(5분봉)·최신 1분봉 ATR(√5 스케일) 중 최댓값.
    // 급증은 봉 마감 전에도 즉시 반영하고, 진정 국면은 장기 평균이 천천히 따라간다.
    // (펄스 임계 계산에도 쓰므로 ATR 모드와 무관하게 매 full 틱 갱신)
    if (market.currentPrice > 0) {
      const atr14 = signal.atr ?? 0;
      const atrFast = computeAtr(candles, 5) ?? 0;
      const oneMin = source.candles.map(toAiCandle);
      const atr1m = computeAtr(oneMin.slice(-16), 15) ?? 0;
      const atrEff = Math.max(atr14, atrFast, atr1m * Math.sqrt(5));
      if (atrEff > 0) {
        const atrPct = (atrEff / market.currentPrice) * 100;
        lastAtrPct = atrPct;

        // 변동성(ATR) 동적 목표/손절 갱신 — 손절은 사용자 설정을 최대 손실 한도로 유지.
        // 목표 하한은 설정값 대신 ATR_TP_MIN_PCT(0.5%) — 저변동 구간에서 더 일찍 익절해
        // 회전을 빠르게 한다(리스크 비확대 방향).
        if (s.config.useAtrLevels) {
          const dynT = Math.round(Math.min(Math.max(atrPct * ATR_TP_MULT, ATR_TP_MIN_PCT), s.config.targetPercent * 3) * 100) / 100;
          const dynS = Math.round(Math.min(Math.max(atrPct * ATR_STOP_MULT, 0.5), s.config.stopLossPercent) * 100) / 100;
          // 데드밴드: 마지막 채택값 대비 0.15%p 이상 움직인 경우에만 갱신 — 미세 출렁임에
          // 목표/손절이 매 틱 흔들리지 않게 한다. 서서히 누적된 드리프트는 임계를 넘는
          // 순간 채택되므로 방향성 변화는 놓치지 않는다.
          const levelDelta =
            s.dynTargetPct === null || s.dynStopPct === null
              ? Number.POSITIVE_INFINITY
              : Math.max(Math.abs(dynT - s.dynTargetPct), Math.abs(dynS - s.dynStopPct));
          if (levelDelta >= DYN_LEVEL_DEADBAND_PCT) {
            s.dynTargetPct = dynT;
            s.dynStopPct = dynS;
            saveState();
            pushLog('skip', `ATR 동적 레벨 갱신: 목표 +${dynT}% / 손절 -${dynS}% (반응형 ATR ${atrPct.toFixed(2)}%)`);
          }
        }
      }
    }
    const effLevels = effectiveLevels(s);

    // 티어드 사전 필터 — 무포지션 + 신호 완전 중립 + 미세 변동이면 AI 호출 생략(비용·노이즈 절감).
    // 공격적 매수 정책과의 충돌 최소화: 추세 up / score>0.5 / RSI 이탈 / 유의미 변동이면 스킵하지 않음.
    if (account.holdingQty <= 0) {
      const flatSignal =
        Math.abs(signal.score) <= 0.5 &&
        (signal.rsi === undefined || (signal.rsi > 45 && signal.rsi < 55));
      const microMove =
        aiLastPrice !== null && aiLastPrice > 0 &&
        (Math.abs(market.currentPrice - aiLastPrice) / aiLastPrice) * 100 < 0.15;
      if (flatSignal && trend.state !== 'up' && microMove) {
        if (Date.now() - lastSkipLogAt > 30 * 60 * 1000) {
          lastSkipLogAt = Date.now();
          pushLog('skip', `AI 호출 생략(사전 필터): 무포지션 · 신호 중립(score ${signal.score}) · 변동 미미 — 다음 변화까지 대기`);
        }
        return; // 기준가(aiLastPrice)는 갱신하지 않음 — 다음 유의미 변동에서 즉시 판단
      }
    }

    const bidTotal = market.bids.reduce((sum, b) => sum + b.q, 0);
    const askTotal = market.asks.reduce((sum, a) => sum + a.q, 0);
    const canFractional = fractionalAllowed(session); // 정규장 + KST 04시 이전
    const sellableForAi = (() => {
      const base = account.sellableQty ?? account.holdingQty;
      const q = canFractional ? base : Math.floor(base);
      return account.holdingQty > 0 ? Math.max(0, q) : undefined;
    })();

    const request: AiDecisionRequest = {
      symbol,
      interval: CANDLE_INTERVAL,
      currency: market.currency,
      currentPrice: market.currentPrice,
      position:
        account.holdingQty > 0 && account.averagePrice > 0
          ? {
              quantity: account.holdingQty,
              averagePrice: account.averagePrice,
              profitLossPct: positionProfitLossPct(account, market.currentPrice),
            }
          : undefined,
      buyingPower: account.buyingPower,
      maxBuyQuantity:
        account.buyingPower && account.buyingPower > 0
          ? Math.floor(account.buyingPower / market.currentPrice)
          : undefined,
      sellableQuantity: sellableForAi,
      targetProfitPct: effLevels.targetPct,
      stopLossPct: effLevels.stopPct,
      signal: { level: signal.level, score: signal.score, rsi: signal.rsi, sma20: signal.sma20, sma50: signal.sma50, atr: signal.atr },
      regime: { adx: regime.adx, state: regime.state },
      marketRef,
      trend: { state: trend.state, confirmedBars: trend.confirmedBars },
      orderbook: {
        bestBid: market.bids[0]?.p,
        bestAsk: market.asks[0]?.p,
        bidRatio: bidTotal + askTotal > 0 ? bidTotal / (bidTotal + askTotal) : undefined,
        bids: market.bids.slice(0, 5),
        asks: market.asks.slice(0, 5),
      },
      openOrders: account.openOrders.slice(0, 10).map((o) => ({ side: o.side, price: o.price, quantity: o.quantity })),
      history: s.aiHistory.slice(0, 8).map((h) => ({
        t: h.t,
        action: h.action,
        confidence: h.confidence,
        executed: h.executed,
        reason: h.reason.slice(0, 100),
        priceAtDecision: h.priceAtDecision,
        // 판단 이후 현재까지 변동률 — 판단 적중 여부의 피드백(모델이 자기 교정에 사용).
        moveSincePct:
          h.priceAtDecision !== undefined && h.priceAtDecision > 0
            ? ((market.currentPrice - h.priceAtDecision) / h.priceAtDecision) * 100
            : undefined,
      })),
      guards: {
        trailingStopPct: s.config.trailingStopPercent > 0 ? s.config.trailingStopPercent : undefined,
        buyMaxPercent: s.config.buyMaxPercent,
        dailyLossLimitUsd: s.config.dailyLossLimitUsd > 0 ? s.config.dailyLossLimitUsd : undefined,
        dailyRealizedUsd: s.config.dailyLossLimitUsd > 0 ? todayRealized() : undefined,
      },
      candles,
    };

    // 클라이언트와 동일: 호출 직전에 기준(시각·가격)을 갱신해 펄스 트리거의 변동률 기준을 옮긴다.
    aiLastCallAt = Date.now();
    aiLastPrice = market.currentPrice;

    const decision = await getAiTradeDecision(request);
    if (!decision.fallback) {
      s.aiHistory.unshift({
        t: Date.now(),
        action: decision.action,
        confidence: decision.confidence,
        executed: false,
        reason: decision.reason,
        priceAtDecision: market.currentPrice,
      });
      s.aiHistory = s.aiHistory.slice(0, MAX_AI_HISTORY);
      saveState();
    }
    pushLog('ai', `AI 판단 ${decision.action}(${Math.round(decision.confidence * 100)}%): ${decision.reason}`);

    if (decision.fallback || decision.action === 'HOLD') return;
    if (decision.action === 'BUY') {
      await executeAiBuy(ctx, decision.sizePct, decision.reason);
    } else {
      const sold = await sellAll(ctx, `AI 매도(전량)`);
      if (sold && s.aiHistory[0]) {
        s.aiHistory[0].executed = true;
        saveState();
      }
    }
    status.lastError = null;
  } catch (error) {
    const message = error instanceof Error ? error.message : '틱 실패';
    status.lastError = message;
    pushLog('error', `판단 틱 실패: ${message}`);
  } finally {
    status.ticking = false;
  }
}

/** 1분 보호 틱 — AI 없이 실보유 보호(손절/보전선/트레일링)만. */
let guardTicking = false;
async function guardTick(): Promise<void> {
  if (guardTicking) return;
  const s = loadState();
  if (!s.config.enabled || !s.config.symbol) return;
  const session = await getUsMarketSession();
  if (!isTradeableSession(session)) return;
  guardTicking = true;
  try {
    const symbol = s.config.symbol;
    const [market, account] = await Promise.all([fetchMarketCtx(symbol), fetchAccountCtx(symbol)]);
    const ctx = { account, market, session };
    updatePositionCache(account, market);
    await cancelStaleOrders(ctx);
    if (account.holdingQty > 0) {
      await runProtectiveGuards(ctx, [], 'protect');
    }
  } catch (error) {
    status.lastError = `보호 틱 실패: ${error instanceof Error ? error.message : '오류'}`;
  } finally {
    guardTicking = false;
  }
}

/** 20초 가격 펄스 — 마지막 AI 판단가 대비 변동성 비례 임계(0.5×ATR%, 0.15~0.6%) 이상 변동 시 즉시 전체 판단 실행.
 *  시세 1건만 조회하는 경량 틱. 기준가가 없으면(첫 판단 전) 쉬고, 최소 간격(20s)을 지킨다. */
let pulsing = false;
async function pulseTick(): Promise<void> {
  if (pulsing || deciding || guardTicking) return;
  const s = loadState();
  if (!s.config.enabled || !s.config.symbol) return;
  if (aiLastPrice === null || Date.now() - aiLastCallAt < AI_MIN_INTERVAL_MS) return;
  pulsing = true;
  try {
    const session = await getUsMarketSession();
    if (!isTradeableSession(session)) return;
    const res = await tossRequest<{ result: { lastPrice?: string }[] }>({
      path: '/api/v1/prices',
      query: { symbols: s.config.symbol },
    });
    const price = Number(res.result?.[0]?.lastPrice);
    if (!Number.isFinite(price) || price <= 0) return;
    const movedPct = (Math.abs(price - aiLastPrice) / aiLastPrice) * 100;
    const threshold = pulseThresholdPct(); // 변동성 비례(0.5×ATR%, 0.15~0.6% 클램프)
    if (movedPct < threshold) return;
    pushLog('trigger', `가격 급변 감지(${movedPct.toFixed(2)}% ≥ ${threshold.toFixed(2)}%) — 즉시 AI 판단 실행`);
    await decisionTick();
  } catch {
    // 시세 조회 실패는 조용히 넘기고 다음 펄스에서 재시도.
  } finally {
    pulsing = false;
  }
}

// ── 상태/스케줄러 ────────────────────────────────────────────────

const status: {
  running: boolean;
  ticking: boolean;
  session: UsMarketSessionKind | null;
  lastTickAt: number | null;
  nextTickAt: number | null;
  lastError: string | null;
  aiConfigured: boolean;
  position: LiveTraderStatus['position'];
} = {
  running: false,
  ticking: false,
  session: null,
  lastTickAt: null,
  nextTickAt: null,
  lastError: null,
  aiConfigured: false,
  position: null,
};

function updatePositionCache(account: AccountCtx, market: MarketCtx): void {
  status.position =
    account.holdingQty > 0 && account.averagePrice > 0
      ? {
          quantity: account.holdingQty,
          averagePrice: account.averagePrice,
          currentPrice: market.currentPrice,
          profitLossPct: positionProfitLossPct(account, market.currentPrice),
        }
      : null;
}

export function getLiveTraderStatus(): LiveTraderStatus {
  const s = loadState();
  return {
    config: s.config,
    running: status.running,
    ticking: status.ticking,
    session: status.session,
    lastTickAt: status.lastTickAt,
    nextTickAt: status.nextTickAt,
    lastError: status.lastError,
    todayRealizedUsd: todayRealized(),
    position: status.position,
    aiConfigured: isAiConfigured(),
    stats: s.stats,
    logs: [...s.logs].reverse(),
  };
}

let timer: ReturnType<typeof setTimeout> | null = null;
let guardTimer: ReturnType<typeof setInterval> | null = null;
let pulseTimer: ReturnType<typeof setInterval> | null = null;

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
    void decisionTick().finally(scheduleNext);
  }, delay);
}

export function startLiveTrader(): void {
  if (status.running) return;
  status.running = true;
  scheduleNext();
  guardTimer = setInterval(() => void guardTick(), GUARD_TICK_INTERVAL_MS);
  pulseTimer = setInterval(() => void pulseTick(), PULSE_INTERVAL_MS);
  console.log(
    '[live] 서버 AI 매매(단일 종목·실주문) 시작 — 5분봉 판단 + 1분 보호 틱 + 20초 변동 펄스(±0.3% 즉시 판단)'
  );
}

export function stopLiveTrader(): void {
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

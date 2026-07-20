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
import { computeSignal, computeTrend } from './candle-signals.js';
import { fetchSourceCandles } from './fetch-source-candles.js';
import { getDefaultAccountSeq, tossRequest } from './toss-client.js';
import {
  getUsMarketSession,
  isTradeableSession,
  type UsMarketSessionKind,
} from './us-market-session.js';

/**
 * 포어그라운드(라이브) AI 트레이더 — 클라이언트 'AI 매매' 모드의 서버 이관.
 *
 * 브라우저 대신 서버가 단일 종목을 주시하며 실제 주문을 낸다. 아이폰/아이패드 등
 * 어느 기기에서 봐도 같은 상태(설정·로그·포지션)를 공유한다.
 *
 * 백그라운드(페이퍼) 엔진과의 구분:
 *  - 이쪽은 "한 번에 한 종목" + "실주문". 페이퍼 엔진은 다종목 + 가상 체결로 병행 유지.
 *  - 판단 주기: 5분봉 마감(+오프셋) AI 판단 + 1분 보호 틱(손절/보전선/트레일링, AI 없음).
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

export interface LiveTraderConfig {
  enabled: boolean;
  symbol: string;
  targetPercent: number;
  stopLossPercent: number;
  trailingStopPercent: number;
  buyMaxPercent: number;
  dailyLossLimitUsd: number;
  holdTpOnTrend: boolean;
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
  aiHistory: { t: number; action: string; confidence: number; executed: boolean; reason: string }[];
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
    s.enabledAt = Date.now();
    s.tpHoldPeak = null;
    s.trailPeak = null;
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

export function getLiveConfig(): LiveTraderConfig {
  return loadState().config;
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
  sellableQty?: number;
  openOrders: { orderId: string; side: 'BUY' | 'SELL'; orderType?: string; price?: number; quantity?: number; orderedAt?: string }[];
}

async function fetchAccountCtx(symbol: string): Promise<AccountCtx> {
  const accountSeq = await resolveAccountSeq();
  const [bpRes, holdingsRes, ordersRes, sellableRes] = await Promise.all([
    tossRequest<{ result: { cashBuyingPower?: string } }>({
      path: '/api/v1/buying-power',
      accountSeq,
      query: { currency: 'USD' },
    }),
    tossRequest<{ result: { items?: { symbol: string; quantity: string; averagePurchasePrice: string }[] } }>({
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
  return {
    accountSeq,
    buyingPower: Number.isFinite(bp) ? bp : undefined,
    holdingQty: item ? Number(item.quantity) : 0,
    averagePrice: item ? Number(item.averagePurchasePrice) : 0,
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
  label: string
): Promise<boolean> {
  const s = loadState();
  const { account, market, session } = ctx;
  const isRegular = session === 'regular';
  // 비정규장 + 보유 1주 미만(소수점 잔량) — 소수점 매도가 불가해 생략.
  // 정수 1주 이상은 정수부 매도가 가능하므로 막지 않는다.
  if (!isRegular && account.holdingQty < 1) {
    pushLog('block', `${label} 생략(보유 ${account.holdingQty}주 < 1주 — 소수점 잔량, 비정규장)`, 'SELL');
    return false;
  }
  const base = account.sellableQty !== undefined && account.sellableQty > 0
    ? account.sellableQty
    : account.holdingQty;
  const qty = isRegular ? Math.floor(base * 1e8) / 1e8 : Math.floor(base);
  if (qty <= 0) {
    pushLog('block', `${label} 생략(매도 가능 수량 없음)`, 'SELL');
    return false;
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

  // 실현 손익 근사(트리거가 기준) → 일일 한도 판정.
  if (account.averagePrice > 0) {
    const realized = (market.currentPrice - account.averagePrice) * qty;
    const total = addRealized(realized);
    const limit = s.config.dailyLossLimitUsd;
    if (limit > 0 && total <= -limit) {
      s.config.enabled = false;
      s.enabledAt = null;
      saveState();
      pushLog('block', `일일 손실 한도 도달($${total.toFixed(2)} ≤ -$${limit}) — 서버 AI 매매 강제 OFF`);
    }
  }
  // 포지션 종료 가정 → 에피소드 추적 상태 해제.
  s.tpHoldPeak = null;
  s.trailPeak = null;
  saveState();
  return true;
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
  const tpPrice = Math.ceil(((avg * (1 + cfg.targetPercent / 100 + r)) / (1 - r)) * 100 - 1e-9) / 100;
  const slPrice = avg * (1 - cfg.stopLossPercent / 100);

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
      s.tpHoldPeak = price;
      saveState();
      pushLog('skip', `익절 보류(상승 추세 ${trend.confirmedBars}봉) — 고점 추적 시작, 보전선 $${tpPrice.toFixed(2)}`, 'SELL');
      return true; // 이번 틱은 홀드 진입으로 처리(AI 생략)
    }
    return sellAll(ctx, `익절 매도(자동): 목표 +${cfg.targetPercent}% 도달`);
  }

  // 3) 트레일링(설정 시).
  if (cfg.trailingStopPercent > 0 && price <= trailPeak * (1 - cfg.trailingStopPercent / 100)) {
    return sellAll(ctx, `트레일링 매도(자동): 고점 $${trailPeak.toFixed(2)} 대비 -${cfg.trailingStopPercent}%`);
  }

  return false;
}

/** 미체결 자동 취소 — 활성화 이후 접수된 지정가 주문이 오래 미체결 + 가격 이탈 시. */
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
    if (!ranAway) continue;
    try {
      await tossRequest({
        method: 'POST',
        path: `/api/v1/orders/${order.orderId}/cancel`,
        accountSeq: ctx.account.accountSeq,
        body: {},
        retryOnRateLimit: false,
      });
      pushLog(
        'exec',
        `미체결 취소: ${order.side === 'BUY' ? '매수' : '매도'} ${order.quantity ?? '-'}주 @ $${order.price} — 가격 이탈, 재판단`,
        order.side
      );
    } catch (error) {
      pushLog('block', `미체결 취소 실패: ${error instanceof Error ? error.message : '오류'}`, order.side);
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
  const limit = cfg.dailyLossLimitUsd;
  if (limit > 0 && todayRealized() <= -limit) {
    pushLog('block', `차단(일일 손실 한도 도달): AI 매수`, 'BUY');
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
  const isRegular = session === 'regular';

  let body: Record<string, unknown>;
  let label: string;
  if (qty >= 1) {
    const exec = floorTick(marketableBuyPrice(price, market.asks));
    body = { symbol: cfg.symbol, side: 'BUY', orderType: 'LIMIT', quantity: qty, price: exec, clientOrderId: `live-${Date.now()}` };
    label = `AI 매수 ${qty}주(비중 ${effectivePct}%) @ $${exec}`;
  } else if (isRegular && budget >= 1) {
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

async function decisionTick(): Promise<void> {
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

    const signal = computeSignal(candles);
    const trend = computeTrend(candles);
    const bidTotal = market.bids.reduce((sum, b) => sum + b.q, 0);
    const askTotal = market.asks.reduce((sum, a) => sum + a.q, 0);
    const isRegular = session === 'regular';
    const sellableForAi = (() => {
      const base = account.sellableQty ?? account.holdingQty;
      const q = isRegular ? base : Math.floor(base);
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
              profitLossPct: ((market.currentPrice - account.averagePrice) / account.averagePrice) * 100,
            }
          : undefined,
      buyingPower: account.buyingPower,
      maxBuyQuantity:
        account.buyingPower && account.buyingPower > 0
          ? Math.floor(account.buyingPower / market.currentPrice)
          : undefined,
      sellableQuantity: sellableForAi,
      targetProfitPct: s.config.targetPercent,
      stopLossPct: s.config.stopLossPercent,
      signal: { level: signal.level, score: signal.score, rsi: signal.rsi, sma20: signal.sma20, sma50: signal.sma50, atr: signal.atr },
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
      })),
      guards: {
        trailingStopPct: s.config.trailingStopPercent > 0 ? s.config.trailingStopPercent : undefined,
        buyMaxPercent: s.config.buyMaxPercent,
        dailyLossLimitUsd: s.config.dailyLossLimitUsd > 0 ? s.config.dailyLossLimitUsd : undefined,
        dailyRealizedUsd: s.config.dailyLossLimitUsd > 0 ? todayRealized() : undefined,
      },
      candles,
    };

    const decision = await getAiTradeDecision(request);
    if (!decision.fallback) {
      s.aiHistory.unshift({
        t: Date.now(),
        action: decision.action,
        confidence: decision.confidence,
        executed: false,
        reason: decision.reason,
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
          profitLossPct: ((market.currentPrice - account.averagePrice) / account.averagePrice) * 100,
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
    logs: [...s.logs].reverse(),
  };
}

let timer: ReturnType<typeof setTimeout> | null = null;
let guardTimer: ReturnType<typeof setInterval> | null = null;

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
  console.log('[live] 서버 AI 매매(단일 종목·실주문) 시작 — 5분봉 판단 + 1분 보호 틱');
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
  status.nextTickAt = null;
}

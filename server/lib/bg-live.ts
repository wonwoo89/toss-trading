import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getAutoTradeConfig,
  saveAutoTradeConfig,
  type AutoSymbolConfig,
} from './auto-trade-config.js';
import { computeTrend } from './candle-signals.js';
import { getDefaultAccountSeq, tossRequest } from './toss-client.js';
import type { AiDecisionCandle } from './ai-decision.js';
import type { UsMarketSessionKind } from './us-market-session.js';

/**
 * 백그라운드 실거래(3단계) — 종목별 배정 풀(poolUsd) 장부 + 실제 주문 실행.
 *
 * 페이퍼($1,000 고정 가상 체결)와 달리, 사용자가 지정한 풀 안에서 실제 주문을 낸다.
 * 실계좌 주문가능금액은 수동 매매·단일 종목 트레이더와 공유되므로, 이 장부가
 * "이 종목 엔진이 쓸 수 있는 돈"의 상한을 자체 추적한다(주문 시 즉시 예약 차감).
 *
 * 미체결 방어 — 단일 종목 트레이더와 동일 규칙:
 *  - 체결 우선 지정가: 상대 호가 ±0.1%(CROSS_BUFFER) 를 넘겨 즉시 체결을 노리되
 *    판단가 ±0.5%(MAX_CHASE) 캡. 정규장 소수점 매도/금액 매수는 시장가.
 *  - 미체결 자동 취소: 접수 90초 경과 + 가격이 불리하게 0.2% 이상 이탈 시 취소하고
 *    장부 예약을 롤백(매수=현금 복원, 매도=수량 복원) → 다음 판단에서 재시도.
 *  - 취소 확인 시점에 열린 주문 목록에 없으면 체결로 간주하고 예약을 확정한다.
 *
 * 소수점/수량 규칙(전 경로 공통):
 *  - 매도: 정규장=소수점 전량 시장가 / 비정규장=정수만(1주 미만 잔량은 생략).
 *  - 매수: 예산 ≥1주=정수 지정가 / 정규장 소수점=금액(orderAmount) 시장가 /
 *    비정규장 1주 폴백(1회 매수 상한 이내).
 */

const CROSS_BUFFER_PCT = 0.1;
const MAX_CHASE_PCT = 0.5;
const STALE_UNFILLED_MS = 90_000;
const STALE_PRICE_AWAY_PCT = 0.2;
const COOLDOWN_MS = 30_000;
const TP_HOLD_TRAIL_PCT = 0.5;
/** 익절 목표가 계산용 편도 수수료 가정(단일 종목 트레이더와 동일). */
const COMMISSION_RATE = 0.001;
const MIN_BUY_BUDGET_USD = 1;

export interface BgLiveOrder {
  orderId: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  placedAt: number;
}

interface BgLivePosition {
  symbol: string;
  /** 배정 풀(USD) — 설정에서 바꾸면 차액만큼 현금이 조정된다. */
  poolUsd: number;
  /** 남은 풀 현금 — 주문 접수 시 즉시 예약 차감, 취소 시 복원. */
  cash: number;
  quantity: number;
  averagePrice: number;
  realizedUsd: number;
  lastPrice: number;
  tpHoldPeak: number | null;
  trailPeak: number | null;
  /** 엔진이 낸 미체결(자체 기록) — 취소/체결 확인의 기준. */
  openOrders: BgLiveOrder[];
  updatedAt: number;
}

interface BgLiveStore {
  positions: Record<string, BgLivePosition>;
  /** 일일 실현 손익(전 실거래 종목 합산, KST) — 전역 일일 손실 한도 판정. */
  dailyDate: string;
  dailyRealizedUsd: number;
}

export interface BgLiveSummary {
  symbol: string;
  poolUsd: number;
  cash: number;
  quantity: number;
  averagePrice: number;
  realizedUsd: number;
  lastPrice: number;
  openOrderCount: number;
  equityUsd: number;
  returnPct: number;
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATA_DIR = path.join(rootDir, 'server', 'data');
const STORE_PATH = path.join(DATA_DIR, 'bg-live-ledger.json');

function kstDate(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

function floorTick(price: number): number {
  return Math.floor(price * 100) / 100;
}

function floorQty(value: number): number {
  return Math.floor(value * 1e8) / 1e8;
}

let cache: BgLiveStore | null = null;

function load(): BgLiveStore {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as Partial<BgLiveStore>;
    cache = {
      positions: raw.positions && typeof raw.positions === 'object' ? raw.positions : {},
      dailyDate: typeof raw.dailyDate === 'string' ? raw.dailyDate : kstDate(),
      dailyRealizedUsd: typeof raw.dailyRealizedUsd === 'number' ? raw.dailyRealizedUsd : 0,
    };
  } catch {
    cache = { positions: {}, dailyDate: kstDate(), dailyRealizedUsd: 0 };
  }
  return cache;
}

function save(): void {
  if (!cache) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(cache, null, 2), 'utf8');
  } catch (error) {
    console.error('[bg-live] 장부 저장 실패:', error);
  }
}

/** 장부 생성/풀 동기화 — poolUsd 변경 시 차액만큼 현금 조정(0 미만 방지). */
export function ensureBgLive(symbol: string, poolUsd: number): BgLivePosition {
  const store = load();
  const key = symbol.toUpperCase();
  const existing = store.positions[key];
  if (!existing) {
    store.positions[key] = {
      symbol: key,
      poolUsd,
      cash: poolUsd,
      quantity: 0,
      averagePrice: 0,
      realizedUsd: 0,
      lastPrice: 0,
      tpHoldPeak: null,
      trailPeak: null,
      openOrders: [],
      updatedAt: Date.now(),
    };
    save();
    return store.positions[key];
  }
  if (existing.poolUsd !== poolUsd) {
    existing.cash = Math.max(0, existing.cash + (poolUsd - existing.poolUsd));
    existing.poolUsd = poolUsd;
    existing.updatedAt = Date.now();
    save();
  }
  return existing;
}

export function getBgLive(symbol: string): BgLivePosition | undefined {
  return load().positions[symbol.toUpperCase()];
}

function summarize(pos: BgLivePosition): BgLiveSummary {
  const markPrice = pos.lastPrice > 0 ? pos.lastPrice : pos.averagePrice;
  const equityUsd = pos.cash + pos.quantity * markPrice;
  return {
    symbol: pos.symbol,
    poolUsd: pos.poolUsd,
    cash: pos.cash,
    quantity: pos.quantity,
    averagePrice: pos.averagePrice,
    realizedUsd: pos.realizedUsd,
    lastPrice: pos.lastPrice,
    openOrderCount: pos.openOrders.length,
    equityUsd,
    returnPct: pos.poolUsd > 0 ? ((equityUsd - pos.poolUsd) / pos.poolUsd) * 100 : 0,
  };
}

export function getBgLiveSummaries(): BgLiveSummary[] {
  return Object.values(load().positions).map(summarize);
}

/** 설정에서 제거되거나 실거래 해제된 종목 장부 정리(보유·미체결 없을 때만 삭제). */
export function pruneBgLive(liveSymbols: string[]): void {
  const store = load();
  const keep = new Set(liveSymbols.map((s) => s.toUpperCase()));
  let changed = false;
  for (const key of Object.keys(store.positions)) {
    const pos = store.positions[key];
    if (!keep.has(key) && pos.quantity <= 0 && pos.openOrders.length === 0) {
      delete store.positions[key];
      changed = true;
    }
  }
  if (changed) save();
}

export function markBgLivePrice(symbol: string, price: number): void {
  const pos = getBgLive(symbol);
  if (!pos || !(price > 0)) return;
  pos.lastPrice = price;
  pos.updatedAt = Date.now();
  save();
}

// ── 일일 실현 손익(전역 한도) ────────────────────────────────────

function todayRealized(): number {
  const store = load();
  const today = kstDate();
  if (store.dailyDate !== today) {
    store.dailyDate = today;
    store.dailyRealizedUsd = 0;
    save();
  }
  return store.dailyRealizedUsd;
}

/** 실현 손익 반영 + 전역 일일 손실 한도 판정. 한도 도달 시 엔진 전역 OFF. */
function addRealized(deltaUsd: number): { total: number; forcedOff: boolean } {
  const store = load();
  todayRealized();
  store.dailyRealizedUsd += deltaUsd;
  save();
  const config = getAutoTradeConfig();
  const limit = config.dailyLossLimitUsd;
  if (limit > 0 && store.dailyRealizedUsd <= -limit && config.enabled) {
    saveAutoTradeConfig({ ...config, enabled: false });
    return { total: store.dailyRealizedUsd, forcedOff: true };
  }
  return { total: store.dailyRealizedUsd, forcedOff: false };
}

export function getBgLiveDailyRealizedUsd(): number {
  return todayRealized();
}

// ── 계좌/주문 헬퍼 ───────────────────────────────────────────────

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

function marketableBuyPrice(price: number, bestAsk?: number): number {
  const base = bestAsk !== undefined && bestAsk > 0 ? Math.max(bestAsk, price) : price;
  return Math.min(base * (1 + CROSS_BUFFER_PCT / 100), price * (1 + MAX_CHASE_PCT / 100));
}

function marketableSellPrice(price: number, bestBid?: number): number {
  const base = bestBid !== undefined && bestBid > 0 ? Math.min(bestBid, price) : price;
  return Math.max(base * (1 - CROSS_BUFFER_PCT / 100), price * (1 - MAX_CHASE_PCT / 100));
}

async function placeOrder(
  body: Record<string, unknown>
): Promise<{ ok: boolean; orderId?: string; error?: string }> {
  try {
    const accountSeq = await resolveAccountSeq();
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

const lastExecAt = new Map<string, number>();

function inCooldown(symbol: string): boolean {
  return Date.now() - (lastExecAt.get(symbol.toUpperCase()) ?? 0) < COOLDOWN_MS;
}

function noteExec(symbol: string): void {
  lastExecAt.set(symbol.toUpperCase(), Date.now());
}

// ── 미체결 취소/체결 확정 ────────────────────────────────────────

/**
 * 엔진이 낸 미체결 주문을 실계좌와 대조한다.
 *  - 계좌 열린 주문에 없으면 → 체결로 간주, 기록만 제거(장부는 접수 시 이미 반영됨).
 *  - 90초 경과 + 가격 0.2% 이상 불리하게 이탈 → 취소 요청 후 장부 예약 롤백.
 * 반환: 로그로 남길 문구 목록.
 */
export async function reconcileBgOrders(symbol: string, currentPrice: number): Promise<string[]> {
  const pos = getBgLive(symbol);
  if (!pos || pos.openOrders.length === 0) return [];
  const notes: string[] = [];
  let accountOpenIds: Set<string>;
  try {
    const accountSeq = await resolveAccountSeq();
    const res = await tossRequest<{ result: { orders?: { orderId: string }[] } }>({
      path: '/api/v1/orders',
      accountSeq,
      query: { status: 'OPEN', symbol },
    });
    accountOpenIds = new Set((res.result?.orders ?? []).map((o) => o.orderId));
  } catch {
    return []; // 조회 실패 — 다음 틱에서 재시도
  }

  const now = Date.now();
  const remaining: BgLiveOrder[] = [];
  for (const order of pos.openOrders) {
    if (!accountOpenIds.has(order.orderId)) {
      // 체결(또는 외부 취소)로 간주 — 접수 시 반영한 장부를 확정.
      notes.push(`체결 확인: ${order.side === 'BUY' ? '매수' : '매도'} ${order.quantity}주 @ $${order.price}`);
      continue;
    }
    const stale = now - order.placedAt >= STALE_UNFILLED_MS;
    const away = STALE_PRICE_AWAY_PCT / 100;
    const ranAway =
      order.side === 'BUY'
        ? currentPrice >= order.price * (1 + away)
        : currentPrice <= order.price * (1 - away);
    if (!(stale && ranAway)) {
      remaining.push(order);
      continue;
    }
    try {
      const accountSeq = await resolveAccountSeq();
      await tossRequest({
        method: 'POST',
        path: `/api/v1/orders/${order.orderId}/cancel`,
        accountSeq,
        body: {},
        retryOnRateLimit: false,
      });
      // 예약 롤백 — 매수: 현금 복원+수량 회수, 매도: 수량 복원+대금 회수(실현도 되돌림).
      if (order.side === 'BUY') {
        pos.cash += order.quantity * order.price;
        const nextQty = floorQty(pos.quantity - order.quantity);
        pos.quantity = Math.max(0, nextQty);
        if (pos.quantity <= 0) {
          pos.quantity = 0;
          pos.averagePrice = 0;
        }
      } else {
        const proceeds = order.quantity * order.price;
        pos.cash = Math.max(0, pos.cash - proceeds);
        const prevQty = pos.quantity;
        pos.quantity = floorQty(pos.quantity + order.quantity);
        // 평단 복원: 매도 시 평단은 유지되므로 avg 그대로. 실현 롤백.
        const realizedDelta = proceeds - pos.averagePrice * order.quantity;
        pos.realizedUsd -= realizedDelta;
        addRealized(-realizedDelta);
        if (prevQty <= 0 && pos.averagePrice <= 0) pos.averagePrice = order.price;
      }
      notes.push(
        `미체결 취소: ${order.side === 'BUY' ? '매수' : '매도'} ${order.quantity}주 @ $${order.price} — 가격 이탈(현재 $${currentPrice.toFixed(2)}), 예약 롤백`
      );
    } catch {
      remaining.push(order); // 취소 실패(이미 체결됐을 수 있음) — 다음 틱 재대조
      notes.push(`미체결 취소 실패(다음 틱 재확인): ${order.side} ${order.quantity}주 @ $${order.price}`);
    }
  }
  pos.openOrders = remaining;
  pos.updatedAt = Date.now();
  save();
  return notes;
}

// ── 매수/매도 실행 ───────────────────────────────────────────────

export interface BgExecResult {
  ok: boolean;
  text: string;
  forcedOff?: boolean;
}

/** 풀 전량 매도(보호/AI 공통) — 세션별 소수점 규칙 + 체결 우선 가격. */
export async function sellAllBgLive(
  symCfg: AutoSymbolConfig,
  market: { price: number; bestBid?: number },
  session: UsMarketSessionKind,
  label: string
): Promise<BgExecResult> {
  const symbol = symCfg.symbol;
  const pos = getBgLive(symbol);
  if (!pos || pos.quantity <= 0) return { ok: false, text: `${label} 생략(풀 보유 없음)` };
  const isRegular = session === 'regular';
  if (!isRegular && pos.quantity < 1) {
    return { ok: false, text: `${label} 생략(보유 ${pos.quantity}주 < 1주 — 소수점 잔량, 비정규장)` };
  }
  if (inCooldown(symbol)) return { ok: false, text: `차단(쿨다운): ${label}` };

  const qty = isRegular ? floorQty(pos.quantity) : Math.floor(pos.quantity);
  if (qty <= 0) return { ok: false, text: `${label} 생략(매도 수량 없음)` };
  const fractional = !Number.isInteger(qty);
  const execPrice = fractional ? market.price : floorTick(marketableSellPrice(market.price, market.bestBid));
  const body: Record<string, unknown> = {
    symbol,
    side: 'SELL',
    orderType: fractional ? 'MARKET' : 'LIMIT',
    quantity: qty,
    clientOrderId: `bg-${Date.now()}`,
  };
  if (!fractional) body.price = execPrice;

  const result = await placeOrder(body);
  if (!result.ok) return { ok: false, text: `${label} 주문 실패: ${result.error}` };
  noteExec(symbol);

  // 접수 시 장부 반영(체결 가정) — 미체결 취소 시 롤백된다.
  const proceeds = qty * execPrice;
  const realizedDelta = proceeds - pos.averagePrice * qty;
  pos.realizedUsd += realizedDelta;
  pos.cash += proceeds;
  pos.quantity = floorQty(pos.quantity - qty);
  if (pos.quantity <= 0) {
    pos.quantity = 0;
    pos.averagePrice = 0;
    pos.tpHoldPeak = null;
    pos.trailPeak = null;
  }
  if (result.orderId && !fractional) {
    pos.openOrders.push({ orderId: result.orderId, side: 'SELL', quantity: qty, price: execPrice, placedAt: Date.now() });
  }
  pos.lastPrice = market.price;
  pos.updatedAt = Date.now();
  save();
  const { forcedOff } = addRealized(realizedDelta);
  return {
    ok: true,
    text: `${label}: ${qty}주 @ ${fractional ? '시장가' : `$${execPrice}`} (실현 ${realizedDelta >= 0 ? '+' : ''}$${realizedDelta.toFixed(2)})`,
    forcedOff,
  };
}

/** AI 매수 — 풀 현금 × 제안 비중(상한 buyMaxPercent) 예산으로 실제 매수 주문. */
export async function executeBgLiveBuy(
  symCfg: AutoSymbolConfig,
  market: { price: number; bestAsk?: number },
  session: UsMarketSessionKind,
  sizePct: number,
  reason: string
): Promise<BgExecResult> {
  const symbol = symCfg.symbol;
  const pos = ensureBgLive(symbol, symCfg.poolUsd);
  if (pos.cash < MIN_BUY_BUDGET_USD) {
    return { ok: false, text: `AI 매수 보류 — 풀 현금 부족($${pos.cash.toFixed(2)}): ${reason}` };
  }
  if (inCooldown(symbol)) return { ok: false, text: '차단(쿨다운): AI 매수' };

  const effectivePct = sizePct > 0 ? Math.min(sizePct, symCfg.buyMaxPercent) : symCfg.buyMaxPercent;
  const budget = Math.min(pos.cash, Math.floor(pos.cash * (effectivePct / 100) * 100) / 100);
  const price = market.price;
  const qty = Math.floor(budget / price);
  const isRegular = session === 'regular';

  let body: Record<string, unknown>;
  let fillQty: number;
  let fillPrice: number;
  let label: string;
  let isAmountOrder = false;
  if (qty >= 1) {
    fillPrice = floorTick(marketableBuyPrice(price, market.bestAsk));
    fillQty = qty;
    body = { symbol, side: 'BUY', orderType: 'LIMIT', quantity: qty, price: fillPrice, clientOrderId: `bg-${Date.now()}` };
    label = `실매수 ${qty}주(비중 ${effectivePct}%) @ $${fillPrice}`;
  } else if (isRegular && budget >= MIN_BUY_BUDGET_USD) {
    isAmountOrder = true;
    fillPrice = price;
    fillQty = floorQty(budget / price);
    body = { symbol, side: 'BUY', orderType: 'MARKET', orderAmount: budget, clientOrderId: `bg-${Date.now()}` };
    label = `실 소수점 매수 $${budget}(비중 ${effectivePct}%) 시장가`;
  } else if (price <= pos.cash * (symCfg.buyMaxPercent / 100) || price <= pos.cash) {
    // 비정규장 1주 폴백 — 풀 현금 이내에서만.
    if (price > pos.cash) {
      return { ok: false, text: `AI 매수 보류 — 풀 현금($${pos.cash.toFixed(2)}) < 1주($${price.toFixed(2)}): ${reason}` };
    }
    fillPrice = floorTick(marketableBuyPrice(price, market.bestAsk));
    fillQty = 1;
    body = { symbol, side: 'BUY', orderType: 'LIMIT', quantity: 1, price: fillPrice, clientOrderId: `bg-${Date.now()}` };
    label = `실매수 1주(비중 ${effectivePct}%→최소 수량) @ $${fillPrice}`;
  } else {
    return { ok: false, text: `AI 매수 보류 — 배정 $${budget}로 1주($${price.toFixed(2)}) 미만: ${reason}` };
  }

  const result = await placeOrder(body);
  if (!result.ok) return { ok: false, text: `AI 매수 주문 실패: ${result.error}` };
  noteExec(symbol);

  // 접수 시 장부 반영(체결 가정) — 미체결 취소 시 롤백.
  const cost = isAmountOrder ? budget : fillQty * fillPrice;
  const nextQty = floorQty(pos.quantity + fillQty);
  pos.averagePrice = nextQty > 0 ? (pos.averagePrice * pos.quantity + fillPrice * fillQty) / nextQty : 0;
  pos.quantity = nextQty;
  pos.cash = Math.max(0, pos.cash - cost);
  if (result.orderId && !isAmountOrder) {
    pos.openOrders.push({ orderId: result.orderId, side: 'BUY', quantity: fillQty, price: fillPrice, placedAt: Date.now() });
  }
  pos.lastPrice = price;
  pos.updatedAt = Date.now();
  save();
  return { ok: true, text: `${label} — ${reason}` };
}

// ── 보호 로직(실거래) — 페이퍼 가드와 동일 규칙, 매도는 실주문 ─────────

export interface BgGuardExit {
  sold: boolean;
  reason: string;
  handled: boolean;
  forcedOff?: boolean;
}

export async function runBgLiveGuards(
  symCfg: AutoSymbolConfig,
  currentPrice: number,
  candles: AiDecisionCandle[],
  session: UsMarketSessionKind,
  mode: 'full' | 'protect' = 'full'
): Promise<BgGuardExit | null> {
  const symbol = symCfg.symbol;
  const pos = getBgLive(symbol);
  if (!pos || pos.quantity <= 0 || pos.averagePrice <= 0) return null;

  const avg = pos.averagePrice;
  const plPct = ((currentPrice - avg) / avg) * 100;
  const r = COMMISSION_RATE;
  const tpPrice = Math.ceil(((avg * (1 + symCfg.targetPercent / 100 + r)) / (1 - r)) * 100 - 1e-9) / 100;
  const slPrice = avg * (1 - symCfg.stopLossPercent / 100);

  const trailPeak = Math.max(pos.trailPeak ?? Math.max(avg, currentPrice), currentPrice);
  if (trailPeak !== pos.trailPeak) {
    pos.trailPeak = trailPeak;
    save();
  }

  const doSell = async (label: string): Promise<BgGuardExit> => {
    const res = await sellAllBgLive(symCfg, { price: currentPrice }, session, label);
    return { sold: res.ok, reason: res.text, handled: true, forcedOff: res.forcedOff };
  };

  // 1) 손절 — 최우선.
  if (currentPrice <= slPrice) {
    return doSell(`손절 매도(자동): 평단 $${avg.toFixed(2)} 대비 ${plPct.toFixed(2)}% ≤ -${symCfg.stopLossPercent}%`);
  }

  const holdTrailPct = symCfg.trailingStopPercent > 0 ? symCfg.trailingStopPercent : TP_HOLD_TRAIL_PCT;

  // 2-a) 추세 홀드 중.
  if (pos.tpHoldPeak !== null && pos.tpHoldPeak !== undefined) {
    const peak = Math.max(pos.tpHoldPeak, currentPrice);
    if (peak !== pos.tpHoldPeak) {
      pos.tpHoldPeak = peak;
      save();
    }
    const floorHit = currentPrice <= tpPrice;
    const trailHit = currentPrice <= peak * (1 - holdTrailPct / 100);
    if (floorHit || trailHit) {
      const why = floorHit ? `보전선 $${tpPrice.toFixed(2)} 이탈` : `고점 $${peak.toFixed(2)} 대비 -${holdTrailPct}%`;
      return doSell(`익절 매도(추세홀드 종료): ${why}`);
    }
    return null;
  }

  // 2-b) 목표 도달 — 추세 확인은 full 틱 전용.
  if (mode === 'full' && currentPrice >= tpPrice) {
    const trend = computeTrend(candles);
    if (trend.state === 'up' && trend.confirmedBars >= 2) {
      pos.tpHoldPeak = currentPrice;
      save();
      return {
        sold: false,
        handled: true,
        reason: `익절 보류(상승 추세 ${trend.confirmedBars}봉) — 고점 추적 시작, 보전선 $${tpPrice.toFixed(2)}`,
      };
    }
    return doSell(`익절 매도(자동): 목표 +${symCfg.targetPercent}% 도달(수수료 반영 $${tpPrice.toFixed(2)})`);
  }

  // 3) 트레일링(설정 시).
  if (symCfg.trailingStopPercent > 0 && currentPrice <= trailPeak * (1 - symCfg.trailingStopPercent / 100)) {
    return doSell(`트레일링 매도(자동): 고점 $${trailPeak.toFixed(2)} 대비 -${symCfg.trailingStopPercent}%`);
  }

  return null;
}

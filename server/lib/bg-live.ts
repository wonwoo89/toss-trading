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
import { isFractionalOrderTime, type UsMarketSessionKind } from './us-market-session.js';

/** 소수점 주문 가능 여부 — 정규장 세션 + KST 04시 이전 소수점 접수 시간대일 때만. */
function fractionalAllowed(session: UsMarketSessionKind): boolean {
  return session === 'regular' && isFractionalOrderTime();
}

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
/** 서킷 브레이커 — 연속 실현 손실이 이 횟수에 도달하면 해당 종목 실거래를 자동 정지. */
const CONSECUTIVE_LOSS_LIMIT = 3;
/** 손실 직후 신규 매수 쿨다운(복수 매매 방지) — 단일 종목 트레이더와 동일. */
const LOSS_COOLDOWN_MS = 5 * 60 * 1000;
/** 익절 목표가 계산용 편도 수수료 가정(단일 종목 트레이더와 동일). */
const COMMISSION_RATE = 0.001;
const MIN_BUY_BUDGET_USD = 1;

export interface BgLiveOrder {
  orderId: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  placedAt: number;
  /** 매도 주문 접수 시점의 평단 — 부분 체결 롤백 시 실현손익·평단 복원에 사용. */
  avgAtOrder?: number;
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
  /** 연속 실현 손실 매도 횟수 — CONSECUTIVE_LOSS_LIMIT 도달 시 종목 자동 정지. */
  lossStreak?: number;
  /** 마지막 실현 손실 시각 — 손실 직후 매수 쿨다운 기준. */
  lastLossAt?: number | null;
  /** 매매 성과 통계(실현 매도 기준). */
  stats?: { sells: number; wins: number; losses: number };
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
  stats: { sells: number; wins: number; losses: number };
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
      lossStreak: 0,
      lastLossAt: null,
      stats: { sells: 0, wins: 0, losses: 0 },
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
  // cash = 풀 예산 − 투자원가(동기화), 포지션가치 = 수량×현재가, 실현손익 누계 포함.
  // → 손익률 = (미실현 + 실현) / 풀. 실계좌 보유 기준이라 장부 드리프트가 없다.
  const equityUsd = pos.cash + pos.quantity * markPrice + pos.realizedUsd;
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
    stats: {
      sells: pos.stats?.sells ?? 0,
      wins: pos.stats?.wins ?? 0,
      losses: pos.stats?.losses ?? 0,
    },
  };
}

/** 통계 필드 폴백 초기화(구버전 장부 호환) — 갱신 직전에 호출. */
function ensureStats(pos: BgLivePosition): { sells: number; wins: number; losses: number } {
  pos.stats ??= { sells: 0, wins: 0, losses: 0 };
  pos.lossStreak ??= 0;
  pos.lastLossAt ??= null;
  return pos.stats;
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

/**
 * 실거래 풀 장부를 실계좌 보유로 재동기화(초기화) — 잘못 어긋난 장부를 실제와 맞춰 새로 시작.
 * 실계좌 보유를 그대로 물려받아(실제 평단) 손절/익절 관리를 이어가고, 실현손익·미체결 기록은
 * 비운다. 현금은 풀 예산에서 보유 원가를 차감(보유 없으면 풀 전액) — 손익률이 실제와 일치.
 * 계좌 조회 실패 시 장부는 그대로 두고 false 를 돌려준다(임의 초기화로 보유를 방치하지 않게).
 */
export async function resyncBgLiveToAccount(symbol: string, poolUsd: number): Promise<boolean> {
  const actual = await fetchActualHolding(symbol);
  if (!actual) return false;
  const store = load();
  const key = symbol.toUpperCase();
  const qty = floorQty(actual.quantity);
  const costBasis = qty * actual.averagePrice;
  store.positions[key] = {
    symbol: key,
    poolUsd,
    cash: Math.max(0, poolUsd - costBasis),
    quantity: qty,
    averagePrice: qty > 0 ? actual.averagePrice : 0,
    realizedUsd: 0,
    lastPrice: 0,
    tpHoldPeak: null,
    trailPeak: null,
    openOrders: [],
    lossStreak: 0,
    lastLossAt: null,
    stats: { sells: 0, wins: 0, losses: 0 },
    updatedAt: Date.now(),
  };
  save();
  return true;
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

/** 실계좌 보유 조회 — 종목 실제 수량·평단(비용 반영 수익률 포함). 실패 시 null. */
async function fetchActualHolding(
  symbol: string
): Promise<{ quantity: number; averagePrice: number } | null> {
  try {
    const accountSeq = await resolveAccountSeq();
    const res = await tossRequest<{
      result: { items?: { symbol: string; quantity: string; averagePurchasePrice: string }[] };
    }>({ path: '/api/v1/holdings', accountSeq });
    const item = res.result?.items?.find((h) => h.symbol.toUpperCase() === symbol.toUpperCase());
    if (!item) return { quantity: 0, averagePrice: 0 };
    return { quantity: Number(item.quantity) || 0, averagePrice: Number(item.averagePurchasePrice) || 0 };
  } catch {
    return null;
  }
}

/** 실계좌 매도가능 수량 — 과매도 방지용. 실패 시 null. */
async function fetchSellableQty(symbol: string): Promise<number | null> {
  try {
    const accountSeq = await resolveAccountSeq();
    const res = await tossRequest<{ result: { sellableQuantity?: string } }>({
      path: '/api/v1/sellable-quantity',
      accountSeq,
      query: { symbol },
    });
    const q = Number(res.result?.sellableQuantity);
    return Number.isFinite(q) ? q : null;
  } catch {
    return null;
  }
}

/**
 * 포지션을 실계좌 보유로 완전 동기화(양방향) — 매 틱 판단 전에 호출.
 * 자체 추적 대신 실계좌를 단일 진실로 삼아 장부 드리프트를 근본 차단한다.
 * (한 종목은 한 풀에만 배정되므로 계좌 보유 = 그 풀의 보유로 간주)
 *  - 수량·평단: 실계좌 값 그대로 채택(많든 적든).
 *  - 현금(가용 예산): 풀 예산 − 투자원가(수량×평단). 실현손익은 예산을 부풀리지 않고
 *    표시 손익률에만 반영(과다 매수 방지, 공유 계좌 안전).
 *  - 보유 0 이면 추세홀드/트레일 추적 해제.
 * 계좌 조회 실패 시 장부를 그대로 두고 null(임의 변경으로 실보유 방치 방지).
 */
export async function syncPositionFromAccount(
  symbol: string,
  poolUsd: number
): Promise<string | null> {
  const pos = getBgLive(symbol);
  if (!pos) return null;
  const actual = await fetchActualHolding(symbol);
  if (!actual) return null;

  const prevQty = pos.quantity;
  const newQty = floorQty(actual.quantity);
  pos.poolUsd = poolUsd;
  pos.quantity = newQty;
  pos.averagePrice = newQty > 0 ? actual.averagePrice : 0;
  pos.cash = Math.max(0, poolUsd - newQty * pos.averagePrice);
  if (newQty <= 0) {
    pos.tpHoldPeak = null;
    pos.trailPeak = null;
  }
  pos.updatedAt = Date.now();
  save();
  if (Math.abs(prevQty - newQty) > 1e-6) {
    return `실계좌 동기화: 보유 ${prevQty}주 → ${newQty}주 (평단 $${pos.averagePrice.toFixed(2)})`;
  }
  return null;
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
 * 엔진이 낸 미체결 주문을 실계좌와 대조한다(장부 포지션은 syncPositionFromAccount 가 담당하므로
 * 여기서는 취소·재호가·추적만 하고 수량/현금은 건드리지 않는다).
 *  - 계좌 열린 주문에 없으면 → 체결/외부취소로 간주해 추적에서 제거.
 *  - 90초 경과 + 가격 0.2% 이상 불리하게 이탈 → 취소만(추격 금지, 다음 판단에서 재시도).
 *  - 90초 경과 + 가격이 아직 부근(호가만 어긋남) → 재호가: 취소 후 현재 체결 우선가로 재접수
 *    (단일 종목 트레이더와 동일 — 특히 보호 매도가 미체결로 방치되지 않게).
 * 반환: 로그로 남길 문구 목록.
 */
export async function reconcileBgOrders(
  symbol: string,
  currentPrice: number,
  book?: { bestBid?: number; bestAsk?: number }
): Promise<string[]> {
  const pos = getBgLive(symbol);
  if (!pos || pos.openOrders.length === 0) return [];
  const notes: string[] = [];
  const accountOpenIds = new Set<string>();
  try {
    const accountSeq = await resolveAccountSeq();
    const res = await tossRequest<{ result: { orders?: { orderId: string }[] } }>({
      path: '/api/v1/orders',
      accountSeq,
      query: { status: 'OPEN', symbol },
    });
    for (const o of res.result?.orders ?? []) accountOpenIds.add(o.orderId);
  } catch {
    return []; // 조회 실패 — 다음 틱에서 재시도
  }

  const now = Date.now();
  const remaining: BgLiveOrder[] = [];
  for (const order of pos.openOrders) {
    if (!accountOpenIds.has(order.orderId)) {
      notes.push(`체결 확인: ${order.side === 'BUY' ? '매수' : '매도'} ${order.quantity}주 @ $${order.price}`);
      continue;
    }
    const stale = now - order.placedAt >= STALE_UNFILLED_MS;
    if (!stale) {
      remaining.push(order);
      continue;
    }
    const away = STALE_PRICE_AWAY_PCT / 100;
    const ranAway =
      order.side === 'BUY'
        ? currentPrice >= order.price * (1 + away)
        : currentPrice <= order.price * (1 - away);
    try {
      const accountSeq = await resolveAccountSeq();
      await tossRequest({
        method: 'POST',
        path: `/api/v1/orders/${order.orderId}/cancel`,
        accountSeq,
        body: {},
        retryOnRateLimit: false,
      });
    } catch {
      remaining.push(order); // 취소 실패(이미 체결됐을 수 있음) — 다음 틱 재대조
      notes.push(`미체결 취소 실패(다음 틱 재확인): ${order.side} ${order.quantity}주 @ $${order.price}`);
      continue;
    }

    if (ranAway) {
      notes.push(
        `미체결 취소: ${order.side === 'BUY' ? '매수' : '매도'} ${order.quantity}주 @ $${order.price} — 가격 이탈(현재 $${currentPrice.toFixed(2)}), 재판단`
      );
      continue;
    }

    // 재호가(cancel-and-replace): 같은 수량을 현재 체결 우선가로 재접수.
    const newPrice =
      order.side === 'BUY'
        ? floorTick(marketableBuyPrice(currentPrice, book?.bestAsk))
        : floorTick(marketableSellPrice(currentPrice, book?.bestBid));
    const replaced = await placeOrder({
      symbol,
      side: order.side,
      orderType: 'LIMIT',
      quantity: order.quantity,
      price: newPrice,
      clientOrderId: `bg-${Date.now()}`,
    });
    if (replaced.ok && replaced.orderId) {
      remaining.push({ ...order, orderId: replaced.orderId, price: newPrice, placedAt: Date.now() });
      notes.push(
        `재호가: ${order.side === 'BUY' ? '매수' : '매도'} ${order.quantity}주 $${order.price} → $${newPrice} (90초 미체결, 체결 우선가로 갱신)`
      );
    } else {
      notes.push(
        `재호가 실패(${order.side} ${order.quantity}주): ${replaced.error ?? '주문 실패'} — 취소만 반영, 다음 판단에서 재시도`
      );
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
  /** 서킷 브레이커 발동(연속 손실) — 이 종목 실거래가 자동 정지됨. */
  circuitOff?: boolean;
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
  // 미체결 매도가 이미 있으면 중복 매도 금지(포지션은 다음 틱 실계좌 동기화로 반영됨).
  if (pos.openOrders.some((o) => o.side === 'SELL')) {
    return { ok: false, text: `${label} 생략 — 미체결 매도 주문 존재` };
  }
  const canFractional = fractionalAllowed(session); // 정규장 + KST 04시 이전 소수점 접수 시간대
  if (!canFractional && pos.quantity < 1) {
    return { ok: false, text: `${label} 생략(보유 ${pos.quantity}주 < 1주 — 소수점 잔량, 소수점 주문 불가 시간대)` };
  }
  if (inCooldown(symbol)) return { ok: false, text: `차단(쿨다운): ${label}` };

  // 과매도 방지 — 실계좌 매도가능 수량으로 상한(장부가 실제보다 많을 때 초과 주문 차단).
  let capQty = pos.quantity;
  let cappedNote = '';
  const sellable = await fetchSellableQty(symbol);
  if (sellable !== null && sellable < pos.quantity - 1e-6) {
    capQty = sellable;
    cappedNote = ` (장부 ${pos.quantity}주 > 실계좌 매도가능 ${sellable}주 — 실제 수량으로 제한)`;
    if (capQty <= 0) {
      // 실제 보유가 없으면 장부를 0으로 정합하고 매도 생략.
      pos.quantity = 0;
      pos.averagePrice = 0;
      pos.tpHoldPeak = null;
      pos.trailPeak = null;
      pos.updatedAt = Date.now();
      save();
      return { ok: false, text: `${label} 생략 — 실계좌 매도가능 0주, 장부 정합${cappedNote}` };
    }
  }

  const qty = canFractional ? floorQty(capQty) : Math.floor(capQty);
  if (qty <= 0) return { ok: false, text: `${label} 생략(매도 수량 없음)` };
  const fractional = !Number.isInteger(qty);
  const execPrice = fractional ? market.price : floorTick(marketableSellPrice(market.price, market.bestBid));
  const avgAtSell = pos.averagePrice;
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
  const realizedDelta = proceeds - avgAtSell * qty;
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
    pos.openOrders.push({ orderId: result.orderId, side: 'SELL', quantity: qty, price: execPrice, placedAt: Date.now(), avgAtOrder: avgAtSell });
  }
  pos.lastPrice = market.price;
  pos.updatedAt = Date.now();

  // 매매 성과 통계 + 서킷 브레이커(연속 손실 시 이 종목 실거래 자동 정지).
  const stats = ensureStats(pos);
  stats.sells += 1;
  let circuitOff = false;
  if (realizedDelta < 0) {
    stats.losses += 1;
    pos.lossStreak = (pos.lossStreak ?? 0) + 1;
    pos.lastLossAt = Date.now();
    if (pos.lossStreak >= CONSECUTIVE_LOSS_LIMIT) {
      const config = getAutoTradeConfig();
      const target = config.symbols.find((c) => c.symbol === symbol && c.live && c.active);
      if (target) {
        saveAutoTradeConfig({
          ...config,
          symbols: config.symbols.map((c) => (c.symbol === symbol ? { ...c, active: false } : c)),
        });
        circuitOff = true;
      }
      pos.lossStreak = 0; // 재활성화 후 새로 계수
    }
  } else if (realizedDelta > 0) {
    stats.wins += 1;
    pos.lossStreak = 0;
  }
  save();
  const { forcedOff } = addRealized(realizedDelta);
  return {
    ok: true,
    text: `${label}: ${qty}주 @ ${fractional ? '시장가' : `$${execPrice}`} (실현 ${realizedDelta >= 0 ? '+' : ''}$${realizedDelta.toFixed(2)})${cappedNote}`,
    forcedOff,
    circuitOff,
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
  // 손실 직후 쿨다운 — 복수 매매(연속 재진입) 방지(단일 종목 트레이더와 동일).
  if (pos.lastLossAt != null && Date.now() - pos.lastLossAt < LOSS_COOLDOWN_MS) {
    const waitMin = Math.ceil((LOSS_COOLDOWN_MS - (Date.now() - pos.lastLossAt)) / 60000);
    return { ok: false, text: `차단(손실 직후 쿨다운 ${waitMin}분 남음): AI 매수 — ${reason.slice(0, 60)}` };
  }
  if (inCooldown(symbol)) return { ok: false, text: '차단(쿨다운): AI 매수' };

  const effectivePct = sizePct > 0 ? Math.min(sizePct, symCfg.buyMaxPercent) : symCfg.buyMaxPercent;
  const budget = Math.min(pos.cash, Math.floor(pos.cash * (effectivePct / 100) * 100) / 100);
  const price = market.price;
  const qty = Math.floor(budget / price);
  const canFractional = fractionalAllowed(session); // 정규장 + KST 04시 이전

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
  } else if (canFractional && budget >= MIN_BUY_BUDGET_USD) {
    isAmountOrder = true;
    fillPrice = price;
    fillQty = floorQty(budget / price);
    body = { symbol, side: 'BUY', orderType: 'MARKET', orderAmount: budget, clientOrderId: `bg-${Date.now()}` };
    label = `실 소수점 매수 $${budget}(비중 ${effectivePct}%) 시장가`;
  } else if (price <= pos.cash * (symCfg.buyMaxPercent / 100) || price <= pos.cash) {
    // 소수점 불가 시간대 1주 폴백 — 풀 현금 이내에서만.
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
  /** 서킷 브레이커 발동(연속 손실) — 이 종목 실거래가 자동 정지됨. */
  circuitOff?: boolean;
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
    return { sold: res.ok, reason: res.text, handled: true, forcedOff: res.forcedOff, circuitOff: res.circuitOff };
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

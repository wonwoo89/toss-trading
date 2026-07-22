import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 페이퍼(가상) 포트폴리오 — 드라이런 모의 매매 장부.
 *
 * 종목마다 가상 현금 $1,000 를 부여하고, AI 판단(BUY/SELL)을 가상으로 체결해
 * 실현·미실현 손익과 수익률을 추적한다. 실주문과 완전히 독립된 장부라
 * 3단계(실주문)가 켜져도 그대로 유지·병행된다.
 *
 * 체결 모델:
 *  - 현재가로 즉시 체결 가정(슬리피지 없음), 소수점 수량 허용(소수 8자리 내림).
 *  - 편도 0.1% 수수료를 매수·매도 양쪽에 반영해 실거래와 유사한 비용을 낸다.
 *  - JSON 파일로 영속 — pm2 재시작/배포 후에도 장부가 이어진다.
 */

export const PAPER_INITIAL_CASH_USD = 1000;
/** 편도 수수료율(0.1%) — 토스 미국주식 수수료 가정. 익절 목표가 계산에도 사용. */
export const PAPER_COMMISSION_RATE = 0.001;
/** 최소 매수 금액 — 이보다 작은 주문은 의미가 없어 생략. */
const MIN_BUY_BUDGET_USD = 1;

export interface PaperPosition {
  symbol: string;
  cash: number;
  quantity: number;
  averagePrice: number;
  /** 수수료 차감 후 실현 손익 누적(USD). */
  realizedPnlUsd: number;
  /** 최근 평가 가격 — 미실현 손익/수익률 계산용. */
  lastPrice: number;
  updatedAt: number;
  /** 추세 홀드 중 고점(목표 도달 후 매도 보류 상태). null=홀드 아님. */
  tpHoldPeak?: number | null;
  /** 포지션 관측 고점 — 트레일링 스탑 판정용. null=미관측. */
  trailPeak?: number | null;
  /** 매매 성과 통계(실현 매도 기준) — 승률 표시용. */
  stats?: { sells: number; wins: number; losses: number };
}

export interface PaperFill {
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
}

export interface PaperSummary extends PaperPosition {
  /** 현금 + 보유 평가금액. */
  equityUsd: number;
  /** 초기 $1,000 대비 수익률(%). */
  returnPct: number;
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATA_DIR = path.join(rootDir, 'server', 'data');
const STORE_PATH = path.join(DATA_DIR, 'paper-portfolio.json');

function floorQty(value: number): number {
  return Math.floor(value * 1e8) / 1e8;
}

let cache: Record<string, PaperPosition> | null = null;

function load(): Record<string, PaperPosition> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as Record<string, PaperPosition>;
    cache = typeof raw === 'object' && raw !== null ? raw : {};
  } catch {
    cache = {};
  }
  return cache;
}

function save(): void {
  if (!cache) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(cache, null, 2), 'utf8');
  } catch (error) {
    console.error('[paper] 장부 저장 실패:', error);
  }
}

function ensure(symbol: string): PaperPosition {
  const store = load();
  const key = symbol.toUpperCase();
  store[key] ??= {
    symbol: key,
    cash: PAPER_INITIAL_CASH_USD,
    quantity: 0,
    averagePrice: 0,
    realizedPnlUsd: 0,
    lastPrice: 0,
    updatedAt: Date.now(),
  };
  return store[key];
}

/** 평가 가격만 갱신(HOLD/판단 생략 시에도 수익률 표시가 현재가를 따라가게). */
export function markPaperPrice(symbol: string, price: number): void {
  if (!(price > 0)) return;
  const pos = ensure(symbol);
  pos.lastPrice = price;
  pos.updatedAt = Date.now();
  save();
}

/**
 * AI 판단을 가상 체결. BUY 는 가상 현금의 sizePct% 를, SELL 은 보유 수량의 sizePct%
 * (0 이하면 전량)를 현재가에 체결한다. 체결이 성립하면 PaperFill 을 돌려준다.
 */
export function applyPaperDecision(
  symbol: string,
  action: 'BUY' | 'SELL',
  sizePct: number,
  price: number
): PaperFill | null {
  if (!(price > 0)) return null;
  const pos = ensure(symbol);
  pos.lastPrice = price;
  pos.updatedAt = Date.now();

  if (action === 'BUY') {
    const pct = Math.min(Math.max(sizePct, 0), 100);
    const budget = pos.cash * (pct / 100);
    if (budget < MIN_BUY_BUDGET_USD) {
      save();
      return null;
    }
    // 수수료 포함 총액이 예산을 넘지 않도록 수량을 역산.
    const quantity = floorQty(budget / (price * (1 + PAPER_COMMISSION_RATE)));
    if (quantity <= 0) {
      save();
      return null;
    }
    const cost = quantity * price * (1 + PAPER_COMMISSION_RATE);
    const nextQty = pos.quantity + quantity;
    pos.averagePrice = (pos.averagePrice * pos.quantity + price * quantity) / nextQty;
    pos.quantity = nextQty;
    pos.cash -= cost;
    save();
    return { side: 'BUY', quantity, price };
  }

  // SELL
  if (pos.quantity <= 0) {
    save();
    return null;
  }
  const pct = sizePct > 0 ? Math.min(sizePct, 100) : 100;
  let quantity = floorQty(pos.quantity * (pct / 100));
  // 잔량이 먼지 수준으로 남으면 전량 처리.
  if (pos.quantity - quantity < 1e-6) quantity = pos.quantity;
  if (quantity <= 0) {
    save();
    return null;
  }
  const proceeds = quantity * price * (1 - PAPER_COMMISSION_RATE);
  const realizedDelta = proceeds - pos.averagePrice * quantity;
  pos.realizedPnlUsd += realizedDelta;
  pos.quantity = floorQty(pos.quantity - quantity);
  pos.cash += proceeds;
  // 매매 성과 통계 — 실현 매도 1건 기준 승/패.
  pos.stats ??= { sells: 0, wins: 0, losses: 0 };
  pos.stats.sells += 1;
  if (realizedDelta > 0) pos.stats.wins += 1;
  else if (realizedDelta < 0) pos.stats.losses += 1;
  if (pos.quantity <= 0) {
    pos.quantity = 0;
    pos.averagePrice = 0;
    // 포지션 종료 → 홀드/트레일 추적 상태 해제(AI 매도·보호 매도 공통).
    pos.tpHoldPeak = null;
    pos.trailPeak = null;
  }
  save();
  return { side: 'SELL', quantity, price };
}

/** 보호 로직(추세 홀드·트레일링)의 추적 상태 갱신 — 장부 파일에 함께 영속된다. */
export function updatePaperTracking(
  symbol: string,
  patch: { tpHoldPeak?: number | null; trailPeak?: number | null }
): void {
  const pos = ensure(symbol);
  if ('tpHoldPeak' in patch) pos.tpHoldPeak = patch.tpHoldPeak ?? null;
  if ('trailPeak' in patch) pos.trailPeak = patch.trailPeak ?? null;
  pos.updatedAt = Date.now();
  save();
}

function summarize(pos: PaperPosition): PaperSummary {
  const markPrice = pos.lastPrice > 0 ? pos.lastPrice : pos.averagePrice;
  const equityUsd = pos.cash + pos.quantity * markPrice;
  return {
    ...pos,
    equityUsd,
    returnPct: ((equityUsd - PAPER_INITIAL_CASH_USD) / PAPER_INITIAL_CASH_USD) * 100,
  };
}

export function getPaperSummary(symbol: string): PaperSummary | undefined {
  const store = load();
  const pos = store[symbol.toUpperCase()];
  return pos ? summarize(pos) : undefined;
}

export function getPaperSummaries(): PaperSummary[] {
  return Object.values(load()).map(summarize);
}

/** 지정 종목(없으면 전체)의 페이퍼 장부를 삭제 — 다음 평가 시 $1,000 로 재시작한다(초기화용). */
export function resetPaperPortfolio(symbols?: string[]): void {
  const store = load();
  if (!symbols) {
    for (const key of Object.keys(store)) delete store[key];
    save();
    return;
  }
  let changed = false;
  for (const s of symbols) {
    const key = s.toUpperCase();
    if (store[key]) {
      delete store[key];
      changed = true;
    }
  }
  if (changed) save();
}

/** 설정에서 제거된 종목의 장부를 정리 — 다시 추가하면 새 $1,000 로 시작한다. */
export function prunePaperPortfolio(keepSymbols: string[]): void {
  const store = load();
  const keep = new Set(keepSymbols.map((s) => s.toUpperCase()));
  let changed = false;
  for (const key of Object.keys(store)) {
    if (!keep.has(key)) {
      delete store[key];
      changed = true;
    }
  }
  if (changed) save();
}

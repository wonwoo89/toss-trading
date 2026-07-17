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
  type PaperFill,
  type PaperSummary,
} from './paper-portfolio.js';
import { getDefaultAccountSeq, tossRequest } from './toss-client.js';
import { getUsMarketSession, type UsMarketSessionKind } from './us-market-session.js';

/**
 * 서버 백그라운드 자동매매 엔진 — 2단계(드라이런).
 *
 * 브라우저 없이 서버가 5분봉 마감마다 활성 종목을 순회하며 토스 API로 직접 데이터를 모아
 * AI 판단(getAiTradeDecision)을 받고, 그 결과를 인메모리 링버퍼에 기록한다.
 * 이 단계에서는 실제 주문을 절대 내지 않는다(planned 는 "실행됐다면" 계획을 보여주는 참고값).
 *
 * 안전:
 *  - 전역 킬스위치(config.enabled=false) 면 어떤 종목도 판단하지 않는다.
 *  - '정규장'에서만 AI를 호출한다 — 프리/애프터는 유동성이 얕고 소수점 주문도 불가하다.
 *  - 구독(OAuth) 경로는 호출마다 무거운 런타임이 뜨므로 종목을 '순차'로 처리한다.
 */

const TICK_INTERVAL_MS = 5 * 60 * 1000; // 5분봉 주기
const TICK_OFFSET_MS = 20 * 1000; // 봉 마감 후 20초 뒤(데이터 반영 여유) 실행
const CANDLE_TARGET = 60; // AI에 넘길 최근 5분봉 개수
const MAX_LOGS = 300;

export interface AutoPlannedOrder {
  side: 'BUY' | 'SELL';
  quantity: number;
  note: string;
}

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
  position?: { quantity: number; averagePrice: number; profitLossPct?: number };
  /** 드라이런: 실제 주문 대신 "실행됐다면" 계획. 3단계에서 실주문으로 승격. */
  planned?: AutoPlannedOrder;
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

interface AccountContext {
  accountSeq: string;
  buyingPower?: number;
  holdings: Map<string, { quantity: number; averagePrice: number }>;
}

interface HoldingItemRaw {
  symbol: string;
  quantity: string;
  averagePurchasePrice: string;
}

interface OrderRawLite {
  side: 'BUY' | 'SELL';
  price?: string;
  quantity?: string;
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

/**
 * 계좌 번호 해석 — .env(TOSS_ACCOUNT_SEQ) 우선, 없으면 계좌 목록을 조회해 첫 계좌를 쓴다
 * (개인용 단일 계좌 전제). 브라우저 요청과 달리 엔진에는 X-Account-Seq 헤더 컨텍스트가
 * 없어서, 이 해석 없이는 계좌 API 가 "x-tossinvest-account 헤더가 필요합니다"로 실패한다.
 */
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
    throw new Error('계좌를 찾지 못했습니다(TOSS_ACCOUNT_SEQ 미설정 + 계좌 목록 비어 있음)');
  }
  cachedAccountSeq = String(first);
  return cachedAccountSeq;
}

async function fetchAccountContext(): Promise<AccountContext> {
  const accountSeq = await resolveAccountSeq();
  const [bpRes, holdingsRes] = await Promise.all([
    tossRequest<{ result: { cashBuyingPower?: string } }>({
      path: '/api/v1/buying-power',
      accountSeq,
      query: { currency: 'USD' },
    }),
    tossRequest<{ result: { items?: HoldingItemRaw[] } }>({
      path: '/api/v1/holdings',
      accountSeq,
    }),
  ]);

  const bp = Number(bpRes.result?.cashBuyingPower);
  const holdings = new Map<string, { quantity: number; averagePrice: number }>();
  for (const item of holdingsRes.result?.items ?? []) {
    holdings.set(item.symbol.toUpperCase(), {
      quantity: Number(item.quantity),
      averagePrice: Number(item.averagePurchasePrice),
    });
  }
  return { accountSeq, buyingPower: Number.isFinite(bp) ? bp : undefined, holdings };
}

/** 드라이런 계획 산출 — 실제 주문은 하지 않고 "실행됐다면" 수량만 계산해 로그에 남긴다. */
function planOrder(
  action: AiAction,
  sizePct: number,
  symCfg: AutoSymbolConfig,
  session: UsMarketSessionKind,
  currentPrice: number,
  buyingPower: number | undefined,
  holdingQty: number,
  sellableQty: number
): AutoPlannedOrder | undefined {
  const fractionalOk = session === 'regular'; // 정규장만 소수점 주문
  if (action === 'BUY') {
    if (!buyingPower || buyingPower <= 0 || currentPrice <= 0) return undefined;
    // 1회 매수는 종목 설정과 서버 상한(buyMaxPercent) 중 작은 쪽으로 제한.
    const effectivePct = Math.min(sizePct, symCfg.buyMaxPercent);
    if (effectivePct <= 0) return undefined;
    const budget = buyingPower * (effectivePct / 100);
    const rawQty = budget / currentPrice;
    const qty = fractionalOk ? Math.floor(rawQty * 1e8) / 1e8 : Math.floor(rawQty);
    if (qty <= 0) return undefined;
    return { side: 'BUY', quantity: qty, note: `주문가능 ${effectivePct}% 배정` };
  }
  if (action === 'SELL') {
    if (holdingQty <= 0) return undefined;
    const base = sellableQty > 0 ? sellableQty : holdingQty;
    const rawQty = base * (Math.min(sizePct, 100) / 100);
    const qty = fractionalOk ? Math.floor(rawQty * 1e8) / 1e8 : Math.floor(rawQty);
    if (qty <= 0) return undefined;
    return { side: 'SELL', quantity: qty, note: `보유 ${base}주 중 ${Math.min(sizePct, 100)}%` };
  }
  return undefined;
}

async function evaluateSymbol(
  symCfg: AutoSymbolConfig,
  config: AutoTradeConfig,
  account: AccountContext,
  session: UsMarketSessionKind
): Promise<void> {
  const symbol = symCfg.symbol;
  const accountSeq = account.accountSeq;

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

  // 2) 현재가·호가·미체결 주문·매도가능수량 — 병렬.
  const [priceRes, orderbookRes, ordersRes, sellableRes] = await Promise.all([
    tossRequest<{ result: { lastPrice?: string; currency?: string }[] }>({
      path: '/api/v1/prices',
      query: { symbols: symbol },
    }),
    tossRequest<{
      result: { bids?: { price: string; volume: string }[]; asks?: { price: string; volume: string }[] };
    }>({ path: '/api/v1/orderbook', query: { symbol } }),
    tossRequest<{ result: { orders?: OrderRawLite[] } }>({
      path: '/api/v1/orders',
      accountSeq,
      query: { status: 'OPEN', symbol },
    }).catch((): { result: { orders?: OrderRawLite[] } } => ({ result: { orders: [] } })),
    tossRequest<{ result: { sellableQuantity?: string } }>({
      path: '/api/v1/sellable-quantity',
      accountSeq,
      query: { symbol },
    }).catch((): { result: { sellableQuantity?: string } } => ({ result: {} })),
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

  const openOrders = (ordersRes.result?.orders ?? []).slice(0, 10).map((o) => ({
    side: o.side,
    price: o.price !== undefined ? Number(o.price) : undefined,
    quantity: o.quantity !== undefined ? Number(o.quantity) : undefined,
  }));

  const holding = account.holdings.get(symbol.toUpperCase());
  const holdingQty = holding?.quantity ?? 0;
  const sellableQty = Number(sellableRes.result?.sellableQuantity);
  const effectiveSellable = Number.isFinite(sellableQty) ? sellableQty : holdingQty;

  const signal = computeSignal(candles);
  const trend = computeTrend(candles);

  const position =
    holding && holding.quantity > 0 && holding.averagePrice > 0
      ? {
          quantity: holding.quantity,
          averagePrice: holding.averagePrice,
          profitLossPct: ((currentPrice - holding.averagePrice) / holding.averagePrice) * 100,
        }
      : undefined;

  const maxBuyQuantity =
    account.buyingPower && account.buyingPower > 0
      ? Math.floor(account.buyingPower / currentPrice)
      : undefined;

  const request: AiDecisionRequest = {
    symbol,
    interval: AUTO_CANDLE_INTERVAL,
    currency,
    currentPrice,
    position,
    buyingPower: account.buyingPower,
    maxBuyQuantity,
    sellableQuantity: Number.isFinite(sellableQty) ? sellableQty : undefined,
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
    openOrders,
    guards: {
      trailingStopPct: symCfg.trailingStopPercent > 0 ? symCfg.trailingStopPercent : undefined,
      buyMaxPercent: symCfg.buyMaxPercent,
      dailyLossLimitUsd: config.dailyLossLimitUsd > 0 ? config.dailyLossLimitUsd : undefined,
    },
    candles,
  };

  const decision = await getAiTradeDecision(request);

  const planned = decision.fallback
    ? undefined
    : planOrder(
        decision.action,
        decision.sizePct,
        symCfg,
        session,
        currentPrice,
        account.buyingPower,
        holdingQty,
        effectiveSellable
      );

  // 페이퍼 체결 — 가상 $1,000 장부에 반영. 매수는 종목 설정의 1회 매수 상한을 그대로 적용해
  // 실주문 모드가 했을 비중과 동일하게 시뮬레이션한다. HOLD/폴백은 평가 가격만 갱신.
  let paperFill: PaperFill | null = null;
  if (!decision.fallback && decision.action !== 'HOLD') {
    const paperPct =
      decision.action === 'BUY' ? Math.min(decision.sizePct, symCfg.buyMaxPercent) : decision.sizePct;
    paperFill = applyPaperDecision(symbol, decision.action, paperPct, currentPrice);
  } else {
    markPaperPrice(symbol, currentPrice);
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
    planned,
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
  if (session !== 'regular') return; // 정규장 전용 — 프리/애프터/데이마켓·마감·휴장은 판단 생략

  ticking = true;
  try {
    const account = await fetchAccountContext();
    for (const symCfg of activeSymbols) {
      try {
        await evaluateSymbol(symCfg, config, account, session);
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
  console.log('[auto-trade] 백그라운드 엔진 시작(드라이런) — 5분봉 마감마다 활성 종목 판단');
}

export function stopAutoTradeEngine(): void {
  status.running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  status.nextTickAt = null;
}

import type {
  Account,
  ApiEnvelope,
  ApiError,
  BuyingPowerRaw,
  CommissionRaw,
  CandleInterval,
  CandlePageRaw,
  CreateOrderPayload,
  OrderCreateResponse,
  ExchangeRateRaw,
  UsMarketCalendarRaw,
  HoldingsItemRaw,
  HoldingsRaw,
  OrderbookRaw,
  OrdersPageRaw,
  PriceInfo,
  SellableQuantityRaw,
  StockInfo,
  StockWarningRaw,
  TradeRaw,
} from '../types';

const API_BASE = '/api';

export type AiAction = 'BUY' | 'SELL' | 'HOLD';

export interface AiDecisionCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface AiDecisionRequest {
  symbol: string;
  interval: string;
  currency?: string;
  currentPrice: number;
  previousClose?: number;
  dayChangePct?: number;
  position?: { quantity: number; averagePrice: number; profitLossPct?: number };
  buyingPower?: number;
  maxBuyQuantity?: number;
  sellableQuantity?: number;
  targetProfitPct?: number;
  stopLossPct?: number;
  signal?: { level?: string; score?: number; rsi?: number; sma20?: number; sma50?: number; atr?: number };
  trend?: { state?: string; confirmedBars?: number };
  orderbook?: {
    bestBid?: number;
    bestAsk?: number;
    bidRatio?: number;
    bids?: { p: number; q: number }[];
    asks?: { p: number; q: number }[];
  };
  openOrders?: { side: 'BUY' | 'SELL'; price?: number; quantity?: number }[];
  history?: {
    t: number;
    action: string;
    confidence?: number;
    executed?: boolean;
    reason?: string;
  }[];
  guards?: {
    trailingStopPct?: number;
    buyMaxPercent?: number;
    dailyLossLimitUsd?: number;
    dailyRealizedUsd?: number;
  };
  candles: AiDecisionCandle[];
}

export interface AiDecision {
  action: AiAction;
  sizePct: number;
  confidence: number;
  reason: string;
  model: string;
  fallback?: boolean;
}

/** 서버 자동매매 엔진 — 종목별 설정(서버 lib/auto-trade-config.ts 와 동일 구조). */
export interface AutoSymbolConfig {
  symbol: string;
  active: boolean;
  targetPercent: number;
  stopLossPercent: number;
  trailingStopPercent: number;
  buyMaxPercent: number;
}

export interface AutoTradeConfig {
  enabled: boolean;
  dailyLossLimitUsd: number;
  symbols: AutoSymbolConfig[];
}

export interface AutoTradeLimits {
  maxSymbols: number;
  maxBuyPercent: number;
  candleInterval: string;
}

/** 페이퍼(가상 $1,000/종목) 포트폴리오 요약 — 드라이런 수익률 표시용. */
export interface PaperSummary {
  symbol: string;
  cash: number;
  quantity: number;
  averagePrice: number;
  realizedPnlUsd: number;
  lastPrice: number;
  updatedAt: number;
  equityUsd: number;
  returnPct: number;
}

export interface AutoEngineStatus {
  running: boolean;
  mode: 'dry-run';
  enabled: boolean;
  aiConfigured: boolean;
  ticking: boolean;
  activeSymbols: string[];
  lastTickAt: number | null;
  lastTickSession: string | null;
  nextTickAt: number | null;
  lastError: string | null;
  candleInterval: string;
  paper: PaperSummary[];
}

export interface AutoLogEntry {
  id: number;
  t: number;
  symbol: string;
  session: string;
  action: AiAction;
  sizePct: number;
  confidence: number;
  reason: string;
  fallback: boolean;
  currentPrice: number;
  /** 페이퍼 장부 기준 포지션(판단 시점) — 실계좌 보유와 무관. */
  position?: { quantity: number; averagePrice: number; profitLossPct?: number };
  paper?: {
    fill?: { side: 'BUY' | 'SELL'; quantity: number; price: number };
    returnPct: number;
    equityUsd: number;
  };
  model: string;
}

export class ApiRequestError extends Error {
  status: number;
  code?: string;
  retryAfterMs?: number;

  constructor(status: number, message: string, code?: string, retryAfterMs?: number) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }

  get isRateLimited() {
    return this.status === 429;
  }
}

function accountHeaders(accountSeq?: string): HeadersInit {
  return accountSeq ? { 'X-Account-Seq': accountSeq } : {};
}

function parseRetryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('Retry-After');
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

async function request<T>(
  path: string,
  options?: RequestInit & { accountSeq?: string }
): Promise<T> {
  const { accountSeq, ...init } = options ?? {};
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...accountHeaders(accountSeq),
      ...init.headers,
    },
  });

  if (!response.ok) {
    // 에러 본문이 JSON 이 아닐 수 있다(프록시 오류·빈 본문 등) → 안전하게 파싱.
    let errorBody: ApiError | undefined;
    try {
      errorBody = (await response.json()) as ApiError;
    } catch {
      errorBody = undefined;
    }

    throw new ApiRequestError(
      response.status,
      errorBody?.error?.message ?? `요청에 실패했습니다 (${response.status})`,
      errorBody?.error?.code,
      parseRetryAfterMs(response)
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export const api = {
  getAccounts: () => request<ApiEnvelope<Account[]>>('/account/accounts'),
  getHoldings: (accountSeq?: string) =>
    request<ApiEnvelope<HoldingsRaw>>('/account/holdings', { accountSeq }),
  getBuyingPower: (accountSeq?: string) =>
    request<ApiEnvelope<BuyingPowerRaw>>('/account/buying-power?currency=USD', { accountSeq }),
  getCommissions: (accountSeq?: string) =>
    request<ApiEnvelope<CommissionRaw[]>>('/account/commissions', { accountSeq }),
  getSellableQuantity: (symbol: string, accountSeq?: string) =>
    request<ApiEnvelope<SellableQuantityRaw>>(`/account/sellable-quantity/${symbol}`, {
      accountSeq,
    }),
  getStock: (symbol: string) => request<ApiEnvelope<StockInfo[]>>(`/market/stocks/${symbol}`),
  searchStocks: (query: string, limit = 12) => {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    return request<ApiEnvelope<StockInfo[]>>(`/market/stocks/search?${params}`);
  },
  getWarnings: (symbol: string) =>
    request<ApiEnvelope<StockWarningRaw[]>>(`/market/stocks/${symbol}/warnings`),
  getPrice: (symbol: string) => request<ApiEnvelope<PriceInfo[]>>(`/market/prices/${symbol}`),
  getOrderbook: (symbol: string) =>
    request<ApiEnvelope<OrderbookRaw>>(`/market/orderbook/${symbol}`),
  getTrades: (symbol: string) => request<ApiEnvelope<TradeRaw[]>>(`/market/trades/${symbol}`),
  getCandles: (symbol: string, interval: CandleInterval = '1m', count = 120, before?: string) => {
    const params = new URLSearchParams({
      interval,
      count: String(count),
    });
    if (before) {
      params.set('before', before);
    }
    return request<ApiEnvelope<CandlePageRaw>>(`/market/candles/${symbol}?${params}`);
  },
  getMarketSnapshot: (symbol: string) =>
    request<
      ApiEnvelope<{
        price: PriceInfo[];
        orderbook: OrderbookRaw;
        trades: TradeRaw[];
      }>
    >(`/market/snapshot/${symbol}`),
  getExchangeRate: () => request<ApiEnvelope<ExchangeRateRaw>>('/market/exchange-rate'),
  getUsMarketCalendar: (date?: string) => {
    const params = date ? `?date=${encodeURIComponent(date)}` : '';
    return request<ApiEnvelope<UsMarketCalendarRaw>>(`/market/market-calendar/us${params}`);
  },
  getPortfolioSnapshot: (accountSeq?: string) =>
    request<
      ApiEnvelope<{
        buyingPower: BuyingPowerRaw;
        holdings: HoldingsRaw;
      }>
    >('/account/snapshot', { accountSeq }),
  getAllOpenOrders: (accountSeq?: string) =>
    request<ApiEnvelope<OrdersPageRaw>>('/orders?status=OPEN', { accountSeq }),
  getTradeSnapshot: (symbol: string, accountSeq?: string) =>
    request<
      ApiEnvelope<{
        orders: OrdersPageRaw;
        sellableQuantity: SellableQuantityRaw | null;
        holding: HoldingsItemRaw | null;
      }>
    >(`/account/snapshot?symbol=${symbol}`, { accountSeq }),
  getOrders: (options?: { status?: string; symbol?: string }, accountSeq?: string) => {
    const params = new URLSearchParams();
    if (options?.status) params.set('status', options.status);
    if (options?.symbol) params.set('symbol', options.symbol.toUpperCase());
    const query = params.toString() ? `?${params}` : '';
    return request<ApiEnvelope<OrdersPageRaw>>(`/orders${query}`, { accountSeq });
  },
  getOpenOrders: (symbol: string, accountSeq?: string) =>
    request<ApiEnvelope<OrdersPageRaw>>(`/orders?status=OPEN&symbol=${symbol}`, { accountSeq }),
  createOrder: (payload: CreateOrderPayload, accountSeq?: string) =>
    request<ApiEnvelope<OrderCreateResponse>>('/orders', {
      method: 'POST',
      body: JSON.stringify(payload),
      accountSeq,
    }),
  cancelOrder: (orderId: string, accountSeq?: string) =>
    request(`/orders/${orderId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
      accountSeq,
    }),
  getAiStatus: () =>
    request<ApiEnvelope<{ configured: boolean; mode: 'api-key' | 'subscription' | null }>>(
      '/ai/status'
    ),
  getAiDecision: (payload: AiDecisionRequest) =>
    request<ApiEnvelope<AiDecision>>('/ai/decision', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  // 서버 백그라운드 자동매매 엔진(브라우저 없이 동작) — 설정·상태·판단 로그.
  getAutoConfig: () =>
    request<ApiEnvelope<{ config: AutoTradeConfig; limits: AutoTradeLimits }>>('/auto/config'),
  saveAutoConfig: (config: AutoTradeConfig) =>
    request<ApiEnvelope<{ config: AutoTradeConfig }>>('/auto/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
  getAutoStatus: () => request<ApiEnvelope<AutoEngineStatus>>('/auto/status'),
  getAutoLogs: (limit = 100) => request<ApiEnvelope<AutoLogEntry[]>>(`/auto/logs?limit=${limit}`),
};

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

export class ApiRequestError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }

  get isRateLimited() {
    return this.status === 429;
  }
}

function accountHeaders(accountSeq?: string): HeadersInit {
  return accountSeq ? { 'X-Account-Seq': accountSeq } : {};
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

  const data = (await response.json()) as T & ApiError;

  if (!response.ok) {
    throw new ApiRequestError(
      response.status,
      data.error?.message ?? `요청에 실패했습니다 (${response.status})`,
      data.error?.code
    );
  }

  return data;
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
  getTradeSnapshot: (symbol: string, accountSeq?: string) => {
    console.log(`[client api] calling getTradeSnapshot for symbol=${symbol}`);
    return request<
      ApiEnvelope<{
        orders: OrdersPageRaw;
        sellableQuantity: SellableQuantityRaw | null;
        holding: HoldingsItemRaw | null;
      }>
    >(`/account/snapshot?symbol=${symbol}`, { accountSeq });
  },
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
};

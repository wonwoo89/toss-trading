import {
  getPortfolioCache,
} from '../lib/portfolioCache'
import {
  sortHoldingsByMarketValue,
} from '../lib/mapPortfolio'

// Symbol trading 관련 폴링 주기 상수
export const MARKET_POLL_MS = 250
export const MARKET_CALENDAR_POLL_MS = 60_000
export const COMMISSIONS_POLL_MS = 300_000
export const CLOSED_ORDERS_POLL_MS = 60_000
export const CANDLE_POLL_MS = 500
export const TRADE_POLL_MS = 15000
export const HOLDINGS_POLL_MS = 5000

export const MARKET_INITIAL_DELAY_MS = 0
export const CANDLE_INITIAL_DELAY_MS = 500
export const TRADE_INITIAL_DELAY_MS = 1000
export const PORTFOLIO_INITIAL_DELAY_MS = 1000

export function getCachedHoldings(accountSeq?: string) {
  if (!accountSeq) return []
  return sortHoldingsByMarketValue(getPortfolioCache(accountSeq)?.holdings ?? [])
}

export function getCachedOpenOrders(accountSeq?: string) {
  if (!accountSeq) return []
  return getPortfolioCache(accountSeq)?.openOrders ?? []
}

// 향후 Symbol별 trade 상태(holding, openOrders, sellable 등)를 관리할 커스텀 훅의 시작점
export interface SymbolTradingOptions {
  symbol?: string
  accountSeq?: string
}

export function useSymbolTrading(options: SymbolTradingOptions = {}) {
  const { symbol, accountSeq } = options

  // 현재는 기존 헬퍼들을 노출. 이후 커밋에서 상태(useState), useEffect, refresh 로직을 점진적으로 이동할 예정
  return {
    symbol,
    accountSeq,
    getCachedHoldings: () => getCachedHoldings(accountSeq),
    getCachedOpenOrders: () => getCachedOpenOrders(accountSeq),
  }
}

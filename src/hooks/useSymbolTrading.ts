import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getPortfolioCache,
  upsertPortfolioHolding,
} from '../lib/portfolioCache'
import {
  sortHoldingsByMarketValue,
} from '../lib/mapPortfolio'
import { fetchTradeSnapshotState } from '../lib/tradeSnapshot'
import type { HoldingItem, Order, TradeSnapshotState } from '../types'

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

  const [sellableQuantity, setSellableQuantity] = useState<number>()
  const [holding, setHolding] = useState<HoldingItem>()
  const [openOrders, setOpenOrders] = useState<Order[]>([])

  const tradeRefreshSeqRef = useRef(0)

  const applyTradeSnapshot = useCallback((state: TradeSnapshotState) => {
    setSellableQuantity(state.sellableQuantity)
    setHolding(state.holding)
    setOpenOrders(state.openOrders)

    if (accountSeq) {
      if (state.holding && state.holding.quantity > 0) {
        upsertPortfolioHolding(accountSeq, state.holding)
      } else {
        upsertPortfolioHolding(accountSeq, {
          symbol: symbol ?? '',
          quantity: 0,
        })
      }
    }
  }, [accountSeq, symbol])

  const refreshTrade = useCallback(async () => {
    if (!accountSeq || !symbol) return

    const seq = ++tradeRefreshSeqRef.current
    const state = await fetchTradeSnapshotState(symbol, accountSeq)
    if (seq === tradeRefreshSeqRef.current) {
      applyTradeSnapshot(state)
    }
    return state
  }, [accountSeq, symbol, applyTradeSnapshot])

  const resetTradeState = useCallback(() => {
    setSellableQuantity(undefined)
    setHolding(undefined)
    setOpenOrders([])
  }, [])

  // symbol 변경 시 trade 상태 자동 리셋 (훅 내부에서 캡슐화)
  useEffect(() => {
    if (!symbol) {
      resetTradeState()
    }
  }, [symbol, resetTradeState])

  return {
    symbol,
    accountSeq,
    sellableQuantity,
    holding,
    openOrders,
    getCachedHoldings: () => getCachedHoldings(accountSeq),
    getCachedOpenOrders: () => getCachedOpenOrders(accountSeq),
    refreshTrade,
    applyTradeSnapshot,
  }
}

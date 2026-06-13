import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../api/client'
import { MarketPanel } from '../components/MarketPanel'
import { OrderForm } from '../components/OrderForm'
import { PortfolioSidebar } from '../components/PortfolioSidebar'

import { useAppContext, useRequireAccountSeq } from '../context/AppContext'
import { useChartCandles } from '../hooks/useChartCandles'
import { usePolling } from '../hooks/usePolling'
import {
  MARKET_POLL_MS,
  MARKET_CALENDAR_POLL_MS,
  COMMISSIONS_POLL_MS,
  CLOSED_ORDERS_POLL_MS,
  CANDLE_POLL_MS,
  TRADE_POLL_MS,
  HOLDINGS_POLL_MS,
  MARKET_INITIAL_DELAY_MS,
  CANDLE_INITIAL_DELAY_MS,
  TRADE_INITIAL_DELAY_MS,
  PORTFOLIO_INITIAL_DELAY_MS,
  getCachedHoldings,
  getCachedOpenOrders,
} from '../hooks/useSymbolTrading'
import {
  getStoredCandleInterval,
  setStoredCandleInterval,
} from '../lib/candleIntervalPreference'
import {
  getStoredTakeProfitRate,
  setStoredTakeProfitRate,
} from '../lib/takeProfitRatePreference'

import { setLastSelectedSymbol } from '../lib/lastSymbolPreference'
import {
  mapHoldings,
  mapOrders,
  resolveLiveProfitLoss,
} from '../lib/mapPortfolio'
import {
  setPortfolioHoldings as savePortfolioHoldings,
  setPortfolioOpenOrders as savePortfolioOpenOrders,
  upsertPortfolioHolding,
} from '../lib/portfolioCache'
import {
  getOpenOrdersSignature,
  refreshOpenOrdersAfterCancel,
  refreshOpenOrdersAfterCreate,
} from '../lib/refreshOpenOrders'
import {
  fetchTradeSnapshotState,
  fetchTradeSnapshotWithRetry,
  type TradeSnapshotState,
} from '../lib/tradeSnapshot'
import { resolveUsCommissionRatePercent } from '../lib/commissionBreakEven'
import {
  calculateTakeProfitSellPrice,
  getTakeProfitCostContext,
  resolveTakeProfitSellQuantity,
  waitForTakeProfitSnapshot,
} from '../lib/takeProfitSell'
import { toNumber, unwrapResult } from '../lib/parse'
import type {
  CandleInterval,
  CreateOrderPayload,
  HoldingItem,
  Order,
  OrderSubmitOptions,
  OrderSubmitResult,
} from '../types'

export function StockPage() {
  const { symbol: routeSymbol } = useParams<{ symbol?: string }>()
  const symbol = routeSymbol?.toUpperCase()
  const hasSymbol = Boolean(symbol)
  const {
    isReady,
    selectedAccountSeq,
    setBuyingPower,
    setTotalMarketValue,
    buyingPower,
  } = useAppContext()
  const requireAccountSeq = useRequireAccountSeq()

  const [stockName, setStockName] = useState<string>()
  const [warnings, setWarnings] = useState<string[]>([])
  const [candleInterval, setCandleInterval] = useState<CandleInterval>(getStoredCandleInterval)
  const [takeProfitRatePercent, setTakeProfitRatePercent] = useState(getStoredTakeProfitRate)
  const [sellableQuantity, setSellableQuantity] = useState<number>()
  const [holding, setHolding] = useState<HoldingItem>()
  const [openOrders, setOpenOrders] = useState<Order[]>([])
  const [portfolioHoldings, setPortfolioHoldings] = useState<HoldingItem[]>(() =>
    getCachedHoldings(selectedAccountSeq),
  )
  const [portfolioOpenOrders, setPortfolioOpenOrders] = useState<Order[]>(() =>
    getCachedOpenOrders(selectedAccountSeq),
  )
  const tradeRefreshSeqRef = useRef(0)
  const layoutRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!symbol) return
    setLastSelectedSymbol(symbol)
  }, [symbol])

  useEffect(() => {
    setHolding(undefined)
    setSellableQuantity(undefined)
    setOpenOrders([])
  }, [symbol])

  useEffect(() => {
    if (!selectedAccountSeq) {
      setPortfolioHoldings([])
      setPortfolioOpenOrders([])
      setTotalMarketValue(undefined)
      return
    }

    const cached = getPortfolioCache(selectedAccountSeq)
    if (cached) {
      setPortfolioHoldings(sortHoldingsByMarketValue(cached.holdings))
      setPortfolioOpenOrders(cached.openOrders)
    }
  }, [selectedAccountSeq, setTotalMarketValue])

  useEffect(() => {
    const total = portfolioHoldings.reduce((sum, item) => sum + (item.marketValue ?? 0), 0)
    setTotalMarketValue(total)
  }, [portfolioHoldings, setTotalMarketValue])

  useEffect(() => {
    if (!isReady || !symbol) return

    let cancelled = false

    const loadStockMeta = async () => {
      try {
        const stockRes = await api.getStock(symbol)
        if (cancelled) return

        const stock = unwrapResult(stockRes)[0]
        setStockName(stock?.englishName ?? stock?.name)

        const warningsRes = await api.getWarnings(symbol).catch(
          () => ({ result: [] as { warningType: string }[] }),
        )
        if (cancelled) return

        setWarnings(unwrapResult(warningsRes).map((warning) => warning.warningType))
      } catch {
        if (!cancelled) {
          setStockName(undefined)
          setWarnings([])
        }
      }
    }

    void loadStockMeta()

    return () => {
      cancelled = true
    }
  }, [isReady, symbol])

  const {
    candles,
    error: candlesError,
    loading: candlesLoading,
    loadingOlder: candlesLoadingOlder,
    hasMoreHistory,
    loadOlder: loadOlderCandles,
    refreshNow: refreshCandlesNow,
  } = useChartCandles(symbol ?? '', candleInterval, isReady && hasSymbol, {
    pollIntervalMs: CANDLE_POLL_MS,
    initialDelayMs: CANDLE_INITIAL_DELAY_MS,
  })

  const applyTradeSnapshot = useCallback(
    (state: TradeSnapshotState, seq: number) => {
      if (seq !== tradeRefreshSeqRef.current) return

      setSellableQuantity(state.sellableQuantity)
      setHolding(state.holding)
      setOpenOrders(state.openOrders)

      if (!selectedAccountSeq) return

      if (state.holding && state.holding.quantity > 0) {
        upsertPortfolioHolding(selectedAccountSeq, state.holding)
      } else {
        upsertPortfolioHolding(selectedAccountSeq, {
          symbol,
          quantity: 0,
        })
      }
    },
    [selectedAccountSeq, symbol],
  )

  const refreshTrade = useCallback(async () => {
    if (!selectedAccountSeq || !symbol) return

    const seq = ++tradeRefreshSeqRef.current
    const state = await fetchTradeSnapshotState(symbol, selectedAccountSeq)
    applyTradeSnapshot(state, seq)
    return state
  }, [applyTradeSnapshot, selectedAccountSeq, symbol])

  const refreshPortfolioHoldings = useCallback(async () => {
    if (!selectedAccountSeq) return

    const snapshot = unwrapResult(await api.getPortfolioSnapshot(selectedAccountSeq))
    const mapped = mapHoldings(snapshot.holdings)

    setBuyingPower(toNumber(snapshot.buyingPower.cashBuyingPower))
    setPortfolioHoldings(mapped)
    savePortfolioHoldings(selectedAccountSeq, mapped)
  }, [selectedAccountSeq, setBuyingPower])

  const refreshPortfolioOpenOrders = useCallback(async (accountSeq?: string) => {
    const targetAccountSeq = accountSeq ?? selectedAccountSeq
    if (!targetAccountSeq) return

    const orders = unwrapResult(await api.getAllOpenOrders(targetAccountSeq))
    const mapped = mapOrders(orders)

    setPortfolioOpenOrders(mapped)
    savePortfolioOpenOrders(targetAccountSeq, mapped)
  }, [selectedAccountSeq])

  const getPortfolioOpenOrders = useCallback(
    (accountSeq: string) => getPortfolioCache(accountSeq)?.openOrders ?? [],
    [],
  )

  const refreshOpenOrdersAfterCreateForAccount = useCallback(
    async (
      accountSeq: string,
      baselineSignature: string,
      createdOrderId?: string,
      orderType: 'LIMIT' | 'MARKET' = 'LIMIT',
    ) => {
      await refreshOpenOrdersAfterCreate(
        () => refreshPortfolioOpenOrders(accountSeq),
        () => getPortfolioOpenOrders(accountSeq),
        baselineSignature,
        createdOrderId,
        orderType,
      )
    },
    [getPortfolioOpenOrders, refreshPortfolioOpenOrders],
  )

  const refreshOpenOrdersAfterCancelForAccount = useCallback(
    async (accountSeq: string, cancelledOrderId: string) => {
      await refreshOpenOrdersAfterCancel(
        () => refreshPortfolioOpenOrders(accountSeq),
        () => getPortfolioOpenOrders(accountSeq),
        cancelledOrderId,
      )
    },
    [getPortfolioOpenOrders, refreshPortfolioOpenOrders],
  )

  const { refreshNow: refreshTradeNow } = usePolling(
    refreshTrade,
    TRADE_POLL_MS,
    isReady && Boolean(selectedAccountSeq) && hasSymbol,
    `${selectedAccountSeq ?? ''}:${symbol ?? ''}`,
    { initialDelayMs: TRADE_INITIAL_DELAY_MS },
  )

  const { refreshing: portfolioHoldingsRefreshing } = usePolling(
    refreshPortfolioHoldings,
    HOLDINGS_POLL_MS,
    isReady && Boolean(selectedAccountSeq),
    `holdings:${selectedAccountSeq ?? ''}`,
    { initialDelayMs: PORTFOLIO_INITIAL_DELAY_MS },
  )

  useEffect(() => {
    if (!isReady || !selectedAccountSeq) return

    const timer = setTimeout(() => {
      void refreshPortfolioOpenOrders()
    }, PORTFOLIO_INITIAL_DELAY_MS)

    return () => clearTimeout(timer)
  }, [isReady, selectedAccountSeq, refreshPortfolioOpenOrders])

  const refreshBuyingPower = useCallback(
    async (accountSeq: string) => {
      const buyingPowerRes = await api.getBuyingPower(accountSeq).catch(() => null)
      if (buyingPowerRes) {
        setBuyingPower(toNumber(unwrapResult(buyingPowerRes).cashBuyingPower))
      }
    },
    [setBuyingPower],
  )

  useEffect(() => {
    const searchInput = document.getElementById('symbol-search')
    if (searchInput instanceof HTMLElement) {
      searchInput.blur()
    }
    layoutRef.current?.focus({ preventScroll: true })
  }, [symbol])

  const marketFetcher = useCallback(async () => {
    if (!symbol) throw new Error('종목이 선택되지 않았습니다.')

    const snapshot = unwrapResult(await api.getMarketSnapshot(symbol))
    const price = snapshot.price[0]
    const orderbook = snapshot.orderbook
    const trades = snapshot.trades

    return {
      price: toNumber(price?.lastPrice),
      bids: orderbook.bids.map((entry) => ({
        price: toNumber(entry.price) ?? 0,
        quantity: toNumber(entry.volume) ?? 0,
      })),
      asks: orderbook.asks.map((entry) => ({
        price: toNumber(entry.price) ?? 0,
        quantity: toNumber(entry.volume) ?? 0,
      })),
      trades: trades.map((trade) => ({
        price: toNumber(trade.price) ?? 0,
        quantity: toNumber(trade.volume) ?? 0,
        timestamp: trade.timestamp,
      })),
    }
  }, [symbol])

  const { data: marketData, refreshNow: refreshMarketNow } = usePolling(
    marketFetcher,
    MARKET_POLL_MS,
    isReady && hasSymbol,
    symbol ?? '',
    { initialDelayMs: MARKET_INITIAL_DELAY_MS },
  )

  const calendarFetcher = useCallback(async () => {
    return unwrapResult(await api.getUsMarketCalendar())
  }, [])

  const {
    data: usMarketCalendar,
    error: usMarketCalendarError,
    loading: usMarketCalendarLoading,
  } = usePolling(calendarFetcher, MARKET_CALENDAR_POLL_MS, isReady, 'us-market-calendar')

  const commissionsFetcher = useCallback(async () => {
    if (!selectedAccountSeq) return []
    return unwrapResult(await api.getCommissions(selectedAccountSeq))
  }, [selectedAccountSeq])

  const { data: commissions } = usePolling(
    commissionsFetcher,
    COMMISSIONS_POLL_MS,
    isReady && Boolean(selectedAccountSeq),
    `commissions:${selectedAccountSeq ?? ''}`,
  )

  const closedOrdersFetcher = useCallback(async () => {
    if (!selectedAccountSeq || !symbol) {
      return { orders: [] as Order[], unavailable: false }
    }

    try {
      const page = unwrapResult(
        await api.getOrders({ status: 'CLOSED', symbol }, selectedAccountSeq),
      )
      return { orders: mapOrders(page), unavailable: false }
    } catch {
      return { orders: [] as Order[], unavailable: true }
    }
  }, [selectedAccountSeq, symbol])

  const { data: closedOrdersState } = usePolling(
    closedOrdersFetcher,
    CLOSED_ORDERS_POLL_MS,
    isReady && Boolean(selectedAccountSeq) && hasSymbol,
    `closed-orders:${selectedAccountSeq ?? ''}:${symbol ?? ''}`,
  )

  const handleTakeProfitRateChange = useCallback((rate: number) => {
    setTakeProfitRatePercent(rate)
    setStoredTakeProfitRate(rate)
  }, [])

  const holdingSummary = useMemo(() => {
    if (!holding || holding.quantity <= 0) return undefined

    const marketValue =
      marketData?.price !== undefined
        ? holding.quantity * marketData.price
        : holding.marketValue
    const purchaseAmount =
      holding.purchaseAmount ??
      (holding.averagePrice !== undefined ? holding.quantity * holding.averagePrice : undefined)

    if (marketValue === undefined || purchaseAmount === undefined) {
      return {
        quantity: holding.quantity,
        averagePrice: holding.averagePrice,
        marketValue: holding.marketValue,
        profitLoss: holding.profitLoss,
        profitLossRate: holding.profitLossRate,
      }
    }

    const { profitLoss, profitLossRate } = resolveLiveProfitLoss(holding, marketValue)

    return {
      quantity: holding.quantity,
      averagePrice: holding.averagePrice,
      marketValue,
      profitLoss,
      profitLossRate,
    }
  }, [holding, marketData?.price])

  const handleCandleIntervalChange = useCallback((interval: CandleInterval) => {
    setCandleInterval(interval)
    setStoredCandleInterval(interval)
  }, [])

  const placeTakeProfitSell = useCallback(
    async (
      accountSeq: string,
      profitRatePercent: number,
      boughtQuantity: number | undefined,
      baselineQuantity: number,
      state: TradeSnapshotState,
    ): Promise<OrderSubmitResult['takeProfitSell']> => {
      const averagePrice = state.holding?.averagePrice
      const sellQuantity = resolveTakeProfitSellQuantity(
        boughtQuantity,
        baselineQuantity,
        state.holding?.quantity,
      )

      if (!averagePrice || averagePrice <= 0) {
        return {
          placed: false,
          message: '평단가를 확인하지 못해 목표 수익률 매도 주문을 넣지 못했습니다.',
        }
      }

      if (!sellQuantity || sellQuantity <= 0) {
        return {
          placed: false,
          message: '체결 수량을 확인하지 못해 목표 수익률 매도 주문을 넣지 못했습니다.',
        }
      }

      const sellPrice = calculateTakeProfitSellPrice(
        averagePrice,
        sellQuantity,
        profitRatePercent,
        getTakeProfitCostContext(state.holding),
      )

      const createdOrder = unwrapResult(
        await api.createOrder(
          {
            symbol: symbol.toUpperCase(),
            side: 'SELL',
            orderType: 'LIMIT',
            quantity: sellQuantity,
            price: sellPrice,
            clientOrderId: crypto.randomUUID(),
          },
          accountSeq,
        ),
      )

      return {
        placed: true,
        price: sellPrice,
        quantity: sellQuantity,
        orderId: createdOrder.orderId,
        message: `세금·수수료 반영 ${profitRatePercent}% 실수익률 목표가 ${sellPrice.toFixed(2)} USD에 ${sellQuantity}주 매도 주문을 넣었습니다.`,
      }
    },
    [symbol],
  )

  const handleCreateOrder = async (
    payload: CreateOrderPayload,
    options?: OrderSubmitOptions,
  ): Promise<OrderSubmitResult> => {
    const accountSeq = requireAccountSeq()
    const openOrdersBaselineSignature = getOpenOrdersSignature(portfolioOpenOrders)
    const baselineQuantity = holding?.quantity ?? 0
    const tradeBaseline: TradeSnapshotState = {
      holding,
      sellableQuantity,
      openOrders,
    }

    const createdOrder = unwrapResult(await api.createOrder(payload, accountSeq))
    await refreshOpenOrdersAfterCreateForAccount(
      accountSeq,
      openOrdersBaselineSignature,
      createdOrder.orderId,
      payload.orderType,
    )

    refreshMarketNow()
    refreshCandlesNow()

    let seq = ++tradeRefreshSeqRef.current
    let state = await fetchTradeSnapshotWithRetry(symbol, accountSeq, tradeBaseline)
    applyTradeSnapshot(state, seq)
    refreshTradeNow()
    await Promise.all([refreshBuyingPower(accountSeq), refreshPortfolioHoldings()])

    let takeProfitSell: OrderSubmitResult['takeProfitSell']

    if (payload.side === 'BUY' && options?.takeProfitSell) {
      state = await waitForTakeProfitSnapshot(
        () => fetchTradeSnapshotState(symbol, accountSeq),
        payload.quantity,
        baselineQuantity,
        state,
      )
      applyTradeSnapshot(state, seq)

      takeProfitSell = await placeTakeProfitSell(
        accountSeq,
        options.takeProfitSell.profitRatePercent,
        payload.quantity,
        baselineQuantity,
        state,
      ).catch((error: unknown) => ({
        placed: false,
        message:
          error instanceof Error
            ? `목표 수익률 매도 주문 실패: ${error.message}`
            : '목표 수익률 매도 주문에 실패했습니다.',
      }))

      if (takeProfitSell?.placed) {
        const openOrdersBeforeTakeProfit = getOpenOrdersSignature(
          getPortfolioOpenOrders(accountSeq),
        )

        seq = ++tradeRefreshSeqRef.current
        state = await fetchTradeSnapshotState(symbol, accountSeq)
        applyTradeSnapshot(state, seq)
        refreshTradeNow()
        await Promise.all([refreshBuyingPower(accountSeq), refreshPortfolioHoldings()])
        await refreshOpenOrdersAfterCreateForAccount(
          accountSeq,
          openOrdersBeforeTakeProfit,
          takeProfitSell.orderId,
          'LIMIT',
        )
      }
    }

    await refreshPortfolioOpenOrders(accountSeq)

    return { takeProfitSell }
  }

  const handleCancelOrder = async (orderId: string) => {
    const accountSeq = requireAccountSeq()

    await api.cancelOrder(orderId, accountSeq)
    await refreshOpenOrdersAfterCancelForAccount(accountSeq, orderId)
    await Promise.all([refreshBuyingPower(accountSeq), refreshPortfolioHoldings()])

    if (!symbol) return

    const seq = ++tradeRefreshSeqRef.current
    const state = await fetchTradeSnapshotState(symbol, accountSeq)
    applyTradeSnapshot(state, seq)
    refreshTradeNow()
  }

  const portfolioTotals = useMemo(() => {
    const totalMarketValue = portfolioHoldings.reduce(
      (sum, item) => sum + (item.marketValue ?? 0),
      0,
    )
    const totalPurchaseAmount = portfolioHoldings.reduce(
      (sum, item) => sum + (item.purchaseAmount ?? 0),
      0,
    )
    const totalProfitLoss =
      portfolioHoldings.length > 0
        ? portfolioHoldings.reduce((sum, item) => sum + (item.profitLoss ?? 0), 0)
        : undefined
    const totalProfitLossRate =
      totalPurchaseAmount > 0 && totalProfitLoss !== undefined
        ? totalProfitLoss / totalPurchaseAmount
        : undefined

    return { totalMarketValue, totalProfitLoss, totalProfitLossRate }
  }, [portfolioHoldings])

  const averagePrice =
    holding && holding.quantity > 0 ? holding.averagePrice : undefined

  const commissionRatePercent = useMemo(
    () => resolveUsCommissionRatePercent(commissions),
    [commissions],
  )

  const marketPanelProps = useMemo(
    () => ({
      symbol,
      stockName,
      bids: marketData?.bids,
      asks: marketData?.asks,
      trades: marketData?.trades,
      candles,
      averagePrice,
      currentPrice: marketData?.price,
      holding: holding && holding.quantity > 0 ? holding : undefined,
      holdingProfitLossRate: holdingSummary?.profitLossRate,
      targetProfitRatePercent: takeProfitRatePercent,
      usMarketDay: usMarketCalendar?.today,
      usMarketCalendarError,
      usMarketCalendarLoading,
      openOrders,
      closedOrders: closedOrdersState?.orders,
      closedOrdersUnavailable: closedOrdersState?.unavailable,
      buyingPower,
      sellableQuantity,
      commissions,
      candleInterval,
      onCandleIntervalChange: handleCandleIntervalChange,
      candlesLoading,
      candlesLoadingOlder,
      candlesError,
      hasMoreHistory,
      onLoadOlderCandles: loadOlderCandles,
      warnings,
    }),
    [
      averagePrice,
      buyingPower,
      candles,
      candlesError,
      candlesLoading,
      candlesLoadingOlder,
      candleInterval,
      closedOrdersState?.orders,
      closedOrdersState?.unavailable,
      commissions,
      handleCandleIntervalChange,
      hasMoreHistory,
      holding,
      holdingSummary?.profitLossRate,
      loadOlderCandles,
      marketData,
      openOrders,
      sellableQuantity,
      stockName,
      symbol,
      takeProfitRatePercent,
      usMarketCalendar?.today,
      usMarketCalendarError,
      usMarketCalendarLoading,
      warnings,
    ],
  )

  return (
    <>
      <main
        ref={layoutRef}
        className={`trading-layout${hasSymbol ? '' : ' trading-layout--portfolio-only'}`}
        tabIndex={-1}
      >
        <div className="trading-layout__main">
          {hasSymbol && symbol ? (
            <>
              <MarketPanel {...marketPanelProps} />
              <section className="order-column">
                <OrderForm
                  symbol={symbol}
                  currentPrice={marketData?.price}
                  buyingPower={buyingPower}
                  sellableQuantity={sellableQuantity}
                  holdingQuantity={holdingSummary?.quantity}
                  holdingAveragePrice={holdingSummary?.averagePrice}
                  holdingMarketValue={holdingSummary?.marketValue}
                  holdingProfitLoss={holdingSummary?.profitLoss}
                  holdingProfitLossRate={holdingSummary?.profitLossRate}
                  takeProfitRatePercent={takeProfitRatePercent}
                  onTakeProfitRateChange={handleTakeProfitRateChange}
                  commissionRatePercent={commissionRatePercent}
                  candles={candles}
                  candleInterval={candleInterval}
                  bids={marketData?.bids}
                  asks={marketData?.asks}
                  trades={marketData?.trades}
                  holding={holding && holding.quantity > 0 ? holding : undefined}
                  openOrders={openOrders}
                  onSubmit={handleCreateOrder}
                />
              </section>
            </>
          ) : (
            <section className="trading-welcome panel">
              <h2>내 포트폴리오</h2>
              <p className="hint">
                우측 보유 종목을 선택하거나 상단 검색으로 종목을 고르면 차트와 주문 화면이
                열립니다.
              </p>
            </section>
          )}
        </div>
        <PortfolioSidebar
          buyingPower={buyingPower}
          totalMarketValue={portfolioTotals.totalMarketValue}
          totalProfitLoss={portfolioTotals.totalProfitLoss}
          totalProfitLossRate={portfolioTotals.totalProfitLossRate}
          holdings={portfolioHoldings}
          openOrders={portfolioOpenOrders}
          activeSymbol={symbol}
          holdingsPollIntervalMs={HOLDINGS_POLL_MS}
          holdingsRefreshing={portfolioHoldingsRefreshing}
          onCancelOrder={handleCancelOrder}
        />
      </main>
    </>
  )
}
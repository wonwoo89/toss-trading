import { US_STOCK_SYMBOLS } from '../data/us-stock-symbols.js'
import { tossRequest } from './toss-client.js'

export interface SearchableStock {
  symbol: string
  name: string
  englishName: string
  market: string
  currency: string
}

const BATCH_SIZE = 200
const MAX_RESULTS = 12

let stockIndex: Map<string, SearchableStock> | null = null
let warmUpPromise: Promise<void> | null = null

function normalizeStock(raw: {
  symbol: string
  name: string
  englishName?: string
  market: string
  currency: string
}): SearchableStock {
  return {
    symbol: raw.symbol,
    name: raw.name,
    englishName: raw.englishName ?? raw.name,
    market: raw.market,
    currency: raw.currency,
  }
}

function upsertStock(stocks: Map<string, SearchableStock>, raw: SearchableStock) {
  stocks.set(raw.symbol, raw)
}

async function fetchStockBatch(symbols: string[]): Promise<SearchableStock[]> {
  if (symbols.length === 0) return []

  const data = await tossRequest<{ result: SearchableStock[] }>({
    path: '/api/v1/stocks',
    query: { symbols: symbols.join(',') },
  })

  return (data.result ?? []).map(normalizeStock)
}

export async function warmUpStockSearchIndex(): Promise<void> {
  if (stockIndex) return
  if (warmUpPromise) {
    await warmUpPromise
    return
  }

  warmUpPromise = (async () => {
    const uniqueSymbols = [...new Set(US_STOCK_SYMBOLS.map((symbol) => symbol.toUpperCase()))]
    const stocks = new Map<string, SearchableStock>()

    for (let i = 0; i < uniqueSymbols.length; i += BATCH_SIZE) {
      const batch = uniqueSymbols.slice(i, i + BATCH_SIZE)
      const fetched = await fetchStockBatch(batch)
      for (const stock of fetched) {
        upsertStock(stocks, stock)
      }
    }

    stockIndex = stocks
  })()

  try {
    await warmUpPromise
  } catch (error) {
    warmUpPromise = null
    throw error
  }
}

async function ensureIndex(): Promise<Map<string, SearchableStock>> {
  await warmUpStockSearchIndex()
  return stockIndex ?? new Map()
}

function looksLikeTicker(query: string): boolean {
  return /^[A-Za-z0-9.^\-]+$/.test(query)
}

function scoreStock(stock: SearchableStock, query: string): number {
  const trimmed = query.trim()
  if (!trimmed) return 0

  const qUpper = trimmed.toUpperCase()
  const qLower = trimmed.toLowerCase()
  const symbol = stock.symbol.toUpperCase()
  const english = stock.englishName.toLowerCase()

  if (symbol === qUpper) return 1000
  if (stock.name === trimmed) return 950
  if (english === qLower) return 900
  if (symbol.startsWith(qUpper) && looksLikeTicker(trimmed)) return 850
  if (stock.name.startsWith(trimmed)) return 800
  if (english.startsWith(qLower)) return 750
  if (stock.name.includes(trimmed)) return 600
  if (english.includes(qLower)) return 500
  if (symbol.includes(qUpper) && looksLikeTicker(trimmed)) return 400

  return 0
}

async function lookupTickerDirect(symbol: string): Promise<SearchableStock | null> {
  try {
    const fetched = await fetchStockBatch([symbol.toUpperCase()])
    const stock = fetched[0]
    if (!stock) return null

    const index = await ensureIndex()
    upsertStock(index, stock)
    return stock
  } catch {
    return null
  }
}

export async function searchStocks(query: string, limit = MAX_RESULTS): Promise<SearchableStock[]> {
  const trimmed = query.trim()
  if (!trimmed) return []

  const index = await ensureIndex()
  const scored: { stock: SearchableStock; score: number }[] = []

  for (const stock of index.values()) {
    const score = scoreStock(stock, trimmed)
    if (score > 0) {
      scored.push({ stock, score })
    }
  }

  if (scored.length === 0 && looksLikeTicker(trimmed)) {
    const direct = await lookupTickerDirect(trimmed)
    if (direct) {
      return [direct]
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.stock.symbol.localeCompare(b.stock.symbol)
  })

  const seen = new Set<string>()
  const results: SearchableStock[] = []

  for (const { stock } of scored) {
    if (seen.has(stock.symbol)) continue
    seen.add(stock.symbol)
    results.push(stock)
    if (results.length >= limit) break
  }

  return results
}

export function registerStocks(stocks: SearchableStock[]) {
  if (!stockIndex) {
    stockIndex = new Map()
  }
  for (const stock of stocks) {
    upsertStock(stockIndex, normalizeStock(stock))
  }
}
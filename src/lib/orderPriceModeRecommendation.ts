import { buildSpreadSnapshot, buildTradeFlowSnapshot } from './marketMicrostructure'

export type RecommendedPriceMode = 'market' | 'current' | 'limit'

export type FillLikelihood = 'high' | 'medium' | 'low' | 'unknown'

export interface OrderPriceModeRecommendationInput {
  side: 'BUY' | 'SELL'
  currentPrice?: number
  bids?: { price: number; quantity: number }[]
  asks?: { price: number; quantity: number }[]
  trades?: { price: number; quantity: number; timestamp: string }[]
  recommendedLimitPrice?: number
}

export interface OrderPriceModeRecommendation {
  available: boolean
  mode: RecommendedPriceMode
  modeLabel: string
  summary: string
  reasons: string[]
  currentFillLikelihood: FillLikelihood
  marketPremiumPerShare?: number
}

const MODE_LABELS: Record<RecommendedPriceMode, string> = {
  market: '시장가',
  current: '현재가',
  limit: '지정가',
}

function formatUsd(value: number) {
  return `$${value.toFixed(2)}`
}

function pickMode(scores: Record<RecommendedPriceMode, number>): RecommendedPriceMode {
  const entries = Object.entries(scores) as [RecommendedPriceMode, number][]
  return entries.reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0]
}

function getGapPercent(gap: number, reference: number) {
  if (reference <= 0) return undefined
  return (gap / reference) * 100
}

export function buildOrderPriceModeRecommendation(
  input: OrderPriceModeRecommendationInput,
): OrderPriceModeRecommendation {
  const {
    side,
    currentPrice,
    bids = [],
    asks = [],
    trades = [],
    recommendedLimitPrice,
  } = input

  if (currentPrice === undefined || currentPrice <= 0) {
    return {
      available: false,
      mode: 'current',
      modeLabel: MODE_LABELS.current,
      summary: '현재가를 불러오는 중입니다.',
      reasons: [],
      currentFillLikelihood: 'unknown',
    }
  }

  const spread = buildSpreadSnapshot(bids, asks)
  const tradeFlow = buildTradeFlowSnapshot(trades, bids, asks)
  const { bestBid, bestAsk, spreadPercent } = spread

  const scores: Record<RecommendedPriceMode, number> = {
    market: 0,
    current: 0,
    limit: 0,
  }
  const reasons: string[] = []
  let currentFillLikelihood: FillLikelihood = 'unknown'
  let marketPremiumPerShare: number | undefined

  if (side === 'BUY') {
    if (bestAsk !== undefined) {
      if (currentPrice >= bestAsk) {
        scores.current += 5
        currentFillLikelihood = 'high'
        reasons.push('현재가가 매도 1호가 이상 → 즉시 체결 가능')
        reasons.push('시장가 대비 가격 상한 확보')
      } else {
        const gap = bestAsk - currentPrice
        marketPremiumPerShare = gap
        const gapPercent = getGapPercent(gap, currentPrice) ?? 0
        currentFillLikelihood = gapPercent <= 0.05 ? 'medium' : 'low'

        if (gapPercent <= 0.03) {
          scores.market += 4
          reasons.push(`매도호가까지 ${formatUsd(gap)} → 시장가 프리미엄 작음`)
        } else if (gapPercent <= 0.08) {
          scores.market += 2
          scores.current += 1
          reasons.push(`현재가는 ${formatUsd(gap)} 아래 → 체결 대기 가능`)
        } else {
          scores.limit += 4
          scores.current += 2
          reasons.push(`현재가와 매도호가 차이 ${formatUsd(gap)} → 대기 유리`)
        }
      }
    } else {
      scores.current += 2
      currentFillLikelihood = 'medium'
      reasons.push('호가 정보 없음 → 현재가 지정가 우선')
    }

    if (spreadPercent !== undefined) {
      if (spreadPercent < 0.05) {
        scores.market += 2
        reasons.push('스프레드 좁음 → 시장가 슬리피지 낮음')
      } else if (spreadPercent > 0.15) {
        scores.limit += 2
        scores.current += 1
        reasons.push('스프레드 넓음 → 시장가 비용 부담')
      }
    }

    if (tradeFlow.buyRatio >= 0.6) {
      scores.market += 2
      reasons.push('체결 매수 우세 → 빠른 진입 유리')
    } else if (tradeFlow.buyRatio <= 0.4) {
      scores.limit += 2
      scores.current += 1
      reasons.push('체결 매도 우세 → 가격 대기 여지')
    }

    if (
      recommendedLimitPrice !== undefined &&
      recommendedLimitPrice > 0 &&
      recommendedLimitPrice < currentPrice
    ) {
      scores.limit += 1
    }
  } else {
    if (bestBid !== undefined) {
      if (currentPrice <= bestBid) {
        scores.current += 5
        currentFillLikelihood = 'high'
        reasons.push('현재가가 매수 1호가 이하 → 즉시 체결 가능')
        reasons.push('시장가 대비 가격 하한 확보')
      } else {
        const gap = currentPrice - bestBid
        marketPremiumPerShare = gap
        const gapPercent = getGapPercent(gap, currentPrice) ?? 0
        currentFillLikelihood = gapPercent <= 0.05 ? 'medium' : 'low'

        if (gapPercent <= 0.03) {
          scores.market += 4
          reasons.push(`매수호가까지 ${formatUsd(gap)} → 시장가 할인 작음`)
        } else if (gapPercent <= 0.08) {
          scores.market += 2
          scores.current += 1
          reasons.push(`현재가는 ${formatUsd(gap)} 위 → 체결 대기 가능`)
        } else {
          scores.limit += 4
          scores.current += 2
          reasons.push(`현재가와 매수호가 차이 ${formatUsd(gap)} → 대기 유리`)
        }
      }
    } else {
      scores.current += 2
      currentFillLikelihood = 'medium'
      reasons.push('호가 정보 없음 → 현재가 지정가 우선')
    }

    if (spreadPercent !== undefined) {
      if (spreadPercent < 0.05) {
        scores.market += 2
        reasons.push('스프레드 좁음 → 시장가 슬리피지 낮음')
      } else if (spreadPercent > 0.15) {
        scores.limit += 2
        scores.current += 1
        reasons.push('스프레드 넓음 → 시장가 체결 손해 가능')
      }
    }

    if (tradeFlow.buyRatio <= 0.4) {
      scores.market += 2
      reasons.push('체결 매도 우세 → 빠른 청산 유리')
    } else if (tradeFlow.buyRatio >= 0.6) {
      scores.limit += 2
      scores.current += 1
      reasons.push('체결 매수 우세 → 더 높은 가격 대기 여지')
    }

    if (
      recommendedLimitPrice !== undefined &&
      recommendedLimitPrice > currentPrice
    ) {
      scores.limit += 1
    }
  }

  const mode = pickMode(scores)

  const summaryByMode: Record<RecommendedPriceMode, string> =
    side === 'BUY'
      ? {
          market: '즉시 체결이 우선이면 시장가가 유리합니다.',
          current:
            currentFillLikelihood === 'high'
              ? '현재가 지정가로 바로 체결되며 가격 상한을 지킬 수 있습니다.'
              : '가격 프리미엄을 줄이려면 현재가 지정가 대기가 유리합니다.',
          limit: '호가·스프레드상 지정가 대기가 가격 대비 가장 유리합니다.',
        }
      : {
          market: '즉시 청산이 우선이면 시장가가 유리합니다.',
          current:
            currentFillLikelihood === 'high'
              ? '현재가 지정가로 바로 체결되며 가격 하한을 지킬 수 있습니다.'
              : '체결가 손실을 줄이려면 현재가 지정가 대기가 유리합니다.',
          limit: '호가·스프레드상 지정가 대기가 가격 대비 가장 유리합니다.',
        }

  const uniqueReasons = [...new Set(reasons)]

  return {
    available: true,
    mode,
    modeLabel: MODE_LABELS[mode],
    summary: summaryByMode[mode],
    reasons: uniqueReasons.slice(0, 4),
    currentFillLikelihood,
    marketPremiumPerShare,
  }
}
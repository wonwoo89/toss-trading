import { formatSignedPercent, formatUsd } from './formatHoldings'
import {
  calculateTakeProfitSellPrice,
  getTakeProfitCostContext,
} from './takeProfitSell'
import type { HoldingItem } from '../types'

export interface HoldingPositionSnapshot {
  visible: boolean
  averagePrice?: number
  profitLossRate?: number
  profitLossRateLabel: string
  targetPrice?: number
  targetProfitRatePercent: number
  distanceToTargetPercent?: number
  distanceToTargetLabel: string
}

export function buildHoldingPositionSnapshot(params: {
  holding?: HoldingItem
  currentPrice?: number
  profitLossRate?: number
  targetProfitRatePercent: number
}): HoldingPositionSnapshot {
  const { holding, currentPrice, profitLossRate, targetProfitRatePercent } = params

  if (!holding || holding.quantity <= 0) {
    return {
      visible: false,
      targetProfitRatePercent,
      profitLossRateLabel: '—',
      distanceToTargetLabel: '—',
    }
  }

  const averagePrice = holding.averagePrice
  let targetPrice: number | undefined

  if (averagePrice && averagePrice > 0) {
    targetPrice = calculateTakeProfitSellPrice(
      averagePrice,
      holding.quantity,
      targetProfitRatePercent,
      getTakeProfitCostContext(holding),
    )
  }

  let distanceToTargetPercent: number | undefined
  if (currentPrice !== undefined && targetPrice !== undefined && currentPrice > 0) {
    distanceToTargetPercent = ((targetPrice - currentPrice) / currentPrice) * 100
  }

  let distanceToTargetLabel = '—'
  if (distanceToTargetPercent !== undefined && targetPrice !== undefined) {
    if (distanceToTargetPercent <= 0) {
      distanceToTargetLabel = `목표 도달 (실수익 ${targetProfitRatePercent}%)`
    } else {
      distanceToTargetLabel = `목표까지 +${distanceToTargetPercent.toFixed(2)}% (${formatUsd(targetPrice)})`
    }
  }

  return {
    visible: true,
    averagePrice,
    profitLossRate,
    profitLossRateLabel: formatSignedPercent(profitLossRate, profitLossRate) ?? '—',
    targetPrice,
    targetProfitRatePercent,
    distanceToTargetPercent,
    distanceToTargetLabel,
  }
}
import {
  formatProfitLoss,
  formatQuantity,
  formatUsd,
  getKrProfitLossClass,
} from '../lib/formatHoldings'

interface StockHoldingSummaryProps {
  quantity?: number
  averagePrice?: number
  marketValue?: number
  profitLoss?: number
  profitLossRate?: number
  variant?: 'inline' | 'order'
}

export function StockHoldingSummary({
  quantity,
  averagePrice,
  marketValue,
  profitLoss,
  profitLossRate,
  variant = 'inline',
}: StockHoldingSummaryProps) {
  if (!quantity || quantity <= 0) return null

  return (
    <div className={`stock-holding-summary stock-holding-summary--${variant}`}>
      <span className="stock-holding-summary__quantity">
        보유 {formatQuantity(quantity)}
        {averagePrice !== undefined && (
          <>
            <span className="stock-holding-summary__divider" aria-hidden="true">
              ·
            </span>
            <span className="stock-holding-summary__average">평단 {formatUsd(averagePrice)}</span>
          </>
        )}
      </span>
      <div className="holding-value stock-holding-summary__value">
        <span>{formatUsd(marketValue)}</span>
        <span className={`holding-pl ${getKrProfitLossClass(profitLoss) ?? ''}`}>
          {formatProfitLoss(profitLoss, profitLossRate)}
        </span>
      </div>
    </div>
  )
}
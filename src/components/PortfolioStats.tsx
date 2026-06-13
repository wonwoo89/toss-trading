import { formatProfitLoss, formatUsd, getKrProfitLossClass } from '../lib/formatHoldings'

interface PortfolioStatsProps {
  buyingPower?: number
  totalMarketValue?: number
  totalProfitLoss?: number
  totalProfitLossRate?: number
}

export function PortfolioStats({
  buyingPower,
  totalMarketValue,
  totalProfitLoss,
  totalProfitLossRate,
}: PortfolioStatsProps) {
  const profitLossClass = getKrProfitLossClass(totalProfitLoss)
  const hasProfitLoss =
    totalProfitLoss !== undefined || totalProfitLossRate !== undefined

  return (
    <div className="portfolio-stats portfolio-stats--sidebar">
      <div className="stat stat--summary-row">
        <div className="stat__summary-item">
          <span>주문 가능 금액</span>
          <strong>
            ${buyingPower?.toLocaleString('en-US', { maximumFractionDigits: 2 }) ?? '—'}
          </strong>
        </div>

        <div className="stat__summary-item stat__summary-item--right">
          <span>총 투자 금액</span>
          <strong className="stat__amount">{formatUsd(totalMarketValue)}</strong>
          {hasProfitLoss && (
            <span className={`stat__pl${profitLossClass ? ` ${profitLossClass}` : ''}`}>
              {formatProfitLoss(totalProfitLoss, totalProfitLossRate)}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
import { formatProfitLoss, formatUsd, getKrProfitLossClass } from '../shared/lib/formatHoldings';
import { Typography } from '../shared/ui/Typography';

interface PortfolioStatsProps {
  buyingPower?: number;
  totalMarketValue?: number;
  totalProfitLoss?: number;
  totalProfitLossRate?: number;
}

export function PortfolioStats({
  buyingPower,
  totalMarketValue,
  totalProfitLoss,
  totalProfitLossRate,
}: PortfolioStatsProps) {
  const profitLossClass = getKrProfitLossClass(totalProfitLoss);
  const hasProfitLoss = totalProfitLoss !== undefined || totalProfitLossRate !== undefined;

  return (
    <div className="portfolio-stats portfolio-stats--sidebar">
      <div className="stat stat--summary-row">
        <div className="stat__summary-item">
          <Typography size={12}>주문 가능 금액</Typography>
          <Typography size={16} as="strong">
            ${buyingPower?.toLocaleString('en-US', { maximumFractionDigits: 2 }) ?? '—'}
          </Typography>
        </div>

        <div className="stat__summary-item stat__summary-item--right">
          <Typography size={12}>총 투자 금액</Typography>
          <Typography size={20} as="strong" className="stat__amount">
            {formatUsd(totalMarketValue)}
          </Typography>
          {hasProfitLoss && (
            <Typography
              size={14}
              className={`stat__pl${profitLossClass ? ` ${profitLossClass}` : ''}`}
            >
              {formatProfitLoss(totalProfitLoss, totalProfitLossRate)}
            </Typography>
          )}
        </div>
      </div>
    </div>
  );
}

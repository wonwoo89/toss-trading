import {
  formatMoney,
  formatPrice,
  formatQuantity,
  formatSignedMoney,
  formatSignedPercent,
  getKrProfitLossClass,
} from '../shared/lib/formatHoldings';

interface StockHoldingSummaryProps {
  quantity?: number;
  averagePrice?: number;
  marketValue?: number;
  profitLoss?: number;
  profitLossRate?: number;
  variant?: 'inline' | 'order';
  currency?: string;
}

export function StockHoldingSummary({
  quantity,
  averagePrice,
  marketValue,
  profitLoss,
  profitLossRate,
  variant = 'inline',
  currency = 'USD',
}: StockHoldingSummaryProps) {
  if (!quantity || quantity <= 0) return null;

  return (
    <div className={`stock-holding-summary stock-holding-summary--${variant}`}>
      <span className="stock-holding-summary__quantity">
        보유 {formatQuantity(quantity)}
        {averagePrice !== undefined && (
          <>
            <span className="stock-holding-summary__divider" aria-hidden="true">
              ·
            </span>
            <span className="stock-holding-summary__average">
              평단 {formatPrice(averagePrice, currency)}
            </span>
          </>
        )}
      </span>
      <div className="holding-value stock-holding-summary__value">
        <span>{formatMoney(marketValue, currency)}</span>
        <span className={`holding-pl ${getKrProfitLossClass(profitLoss) ?? ''}`}>
          {profitLoss === undefined && profitLossRate === undefined
            ? '—'
            : `${formatSignedMoney(profitLoss, currency)}${
                formatSignedPercent(profitLossRate, profitLoss)
                  ? ` (${formatSignedPercent(profitLossRate, profitLoss)})`
                  : ''
              }`}
        </span>
      </div>
    </div>
  );
}

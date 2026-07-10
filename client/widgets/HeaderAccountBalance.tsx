import { formatKrw, formatUsd } from '../shared/lib/formatHoldings';
import { useAccountSummary } from '../shared/hooks/useAccountSummary';
import { Typography } from '../shared/ui/Typography';

export function HeaderAccountBalance() {
  const { isReady, exchangeRate, totalAccountValue, totalAccountValueKrw } = useAccountSummary();

  if (!isReady) return null;

  return (
    <div className="header-finance" aria-label="총 계좌 및 환율">
      <div className="header-account-balance">
        <Typography size={12} className="header-account-balance__label">총 계좌</Typography>
        <div className="header-account-balance__amounts">
          <div className="header-exchange-rate">
            <Typography size={10} className="header-exchange-rate__value">
              {exchangeRate !== undefined ? `$1 = ${formatKrw(exchangeRate)}` : '—'}
            </Typography>
          </div>
          <Typography size={12} className="header-finance__divider" aria-hidden="true">
            ·
          </Typography>
          {totalAccountValueKrw !== undefined && (
            <Typography size={10} className="header-account-balance__krw">
              {formatKrw(totalAccountValueKrw)}
            </Typography>
          )}
          <Typography as="strong" size={16} className="header-account-balance__value">
            {formatUsd(totalAccountValue)}
          </Typography>
        </div>
      </div>
    </div>
  );
}

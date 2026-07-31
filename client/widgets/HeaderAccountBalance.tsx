import { formatUsd } from '../shared/lib/formatHoldings';
import { useAccountSummary } from '../shared/hooks/useAccountSummary';
import { Typography } from '../shared/ui/Typography';

export function HeaderAccountBalance() {
  const { isReady, totalAccountValue } = useAccountSummary();

  if (!isReady) return null;

  return (
    <div className="header-finance" aria-label="총 계좌">
      <div className="header-account-balance">
        <Typography size={12} className="header-account-balance__label">총 계좌</Typography>
        <div className="header-account-balance__amounts">
          <Typography as="strong" size={16} className="header-account-balance__value">
            {formatUsd(totalAccountValue)}
          </Typography>
        </div>
      </div>
    </div>
  );
}

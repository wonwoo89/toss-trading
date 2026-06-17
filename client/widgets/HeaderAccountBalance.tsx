import { formatKrw, formatUsd } from '../shared/lib/formatHoldings';
import { useAccountSummary } from '../shared/hooks/useAccountSummary';

export function HeaderAccountBalance() {
  const { isReady, exchangeRate, totalAccountValue, totalAccountValueKrw } = useAccountSummary();

  if (!isReady) return null;

  return (
    <div className="header-finance" aria-label="총 계좌 및 환율">
      <div className="header-account-balance">
        <span className="header-account-balance__label">총 계좌</span>
        <div className="header-account-balance__amounts">
          <div className="header-exchange-rate">
            <span className="header-exchange-rate__value">
              {exchangeRate !== undefined ? `$1 = ${formatKrw(exchangeRate)}` : '—'}
            </span>
          </div>
          <span className="header-finance__divider" aria-hidden="true">
            ·
          </span>
          {totalAccountValueKrw !== undefined && (
            <span className="header-account-balance__krw">{formatKrw(totalAccountValueKrw)}</span>
          )}
          <strong className="header-account-balance__value">{formatUsd(totalAccountValue)}</strong>
        </div>
      </div>
    </div>
  );
}

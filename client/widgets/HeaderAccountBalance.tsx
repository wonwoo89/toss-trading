import { useMemo } from 'react';
import { useAppContext } from '../app/providers/AppContext';
import { formatKrw, formatUsd } from '../shared/lib/formatHoldings';

export function HeaderAccountBalance() {
  const { isReady, buyingPower, totalMarketValue, exchangeRate } = useAppContext();

  const totalAccountValue = useMemo(() => {
    if (buyingPower === undefined && totalMarketValue === undefined) return undefined;
    return (buyingPower ?? 0) + (totalMarketValue ?? 0);
  }, [buyingPower, totalMarketValue]);

  const totalAccountValueKrw = useMemo(() => {
    if (totalAccountValue === undefined || exchangeRate === undefined) return undefined;
    return totalAccountValue * exchangeRate;
  }, [exchangeRate, totalAccountValue]);

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

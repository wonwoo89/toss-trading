import { useMemo } from 'react';
import { useAppContext } from '../context/AppContext';
import { formatKrw, formatUsd } from '../lib/formatHoldings';

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
          <strong className="header-account-balance__value">{formatUsd(totalAccountValue)}</strong>
          {totalAccountValueKrw !== undefined && (
            <span className="header-account-balance__krw">{formatKrw(totalAccountValueKrw)}</span>
          )}
        </div>
      </div>
      <span className="header-finance__divider" aria-hidden="true">
        ·
      </span>
      <div className="header-exchange-rate">
        <span className="header-exchange-rate__label">환율</span>
        <span className="header-exchange-rate__value">
          {exchangeRate !== undefined ? `1 USD = ${formatKrw(exchangeRate)}` : '—'}
        </span>
      </div>
    </div>
  );
}

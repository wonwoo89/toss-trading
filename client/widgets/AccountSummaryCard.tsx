import { formatKrw, formatUsd } from '../shared/lib/formatHoldings';
import { useAccountSummary } from '../shared/hooks/useAccountSummary';

/**
 * 자산 탭 상단 '내 계좌' 인라인 카드 — 드롭다운 없이 총 계좌·환율을 항상 펼쳐 표시.
 * (헤더의 HeaderAccountMenu 를 대체하는 v2 전용 표시)
 */
export function AccountSummaryCard() {
  const { isReady, exchangeRate, totalAccountValue, totalAccountValueKrw } = useAccountSummary();

  if (!isReady) return null;

  return (
    <section className="account-summary-card" aria-label="총 계좌 및 환율">
      <div className="account-summary-card__row">
        <span className="account-summary-card__label">총 계좌</span>
        <span className="account-summary-card__amount">
          <strong>{formatUsd(totalAccountValue)}</strong>
          {totalAccountValueKrw !== undefined && (
            <span className="account-summary-card__krw">{formatKrw(totalAccountValueKrw)}</span>
          )}
        </span>
      </div>
      <div className="account-summary-card__row">
        <span className="account-summary-card__label">환율</span>
        <span className="account-summary-card__rate">
          {exchangeRate !== undefined ? `$1 = ${formatKrw(exchangeRate)}` : '—'}
        </span>
      </div>
    </section>
  );
}

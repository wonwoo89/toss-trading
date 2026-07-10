import { formatKrw, formatUsd } from '../shared/lib/formatHoldings';
import { useAccountSummary } from '../shared/hooks/useAccountSummary';
import { Typography } from '../shared/ui/Typography';

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
        <Typography size={14} className="account-summary-card__label">총 계좌</Typography>
        <span className="account-summary-card__amount">
          <Typography size={16} as="strong">{formatUsd(totalAccountValue)}</Typography>
          {totalAccountValueKrw !== undefined && (
            <Typography size={14} className="account-summary-card__krw">
              {formatKrw(totalAccountValueKrw)}
            </Typography>
          )}
        </span>
      </div>
      <div className="account-summary-card__row">
        <Typography size={14} className="account-summary-card__label">환율</Typography>
        <Typography size={14} className="account-summary-card__rate">
          {exchangeRate !== undefined ? `$1 = ${formatKrw(exchangeRate)}` : '—'}
        </Typography>
      </div>
    </section>
  );
}

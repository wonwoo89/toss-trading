import { formatUsd } from '../shared/lib/formatHoldings';
import { useAccountSummary } from '../shared/hooks/useAccountSummary';
import { Typography } from '../shared/ui/Typography';

/**
 * 자산 탭 상단 '내 계좌' 인라인 카드 — 드롭다운 없이 총 계좌를 항상 펼쳐 표시.
 * (헤더의 HeaderAccountMenu 를 대체하는 v2 전용 표시)
 */
export function AccountSummaryCard() {
  const { isReady, totalAccountValue } = useAccountSummary();

  if (!isReady) return null;

  return (
    <section className="account-summary-card" aria-label="총 계좌">
      <div className="account-summary-card__row">
        <Typography size={14} className="account-summary-card__label">총 계좌</Typography>
        <span className="account-summary-card__amount">
          <Typography size={16} as="strong">{formatUsd(totalAccountValue)}</Typography>
        </span>
      </div>
    </section>
  );
}

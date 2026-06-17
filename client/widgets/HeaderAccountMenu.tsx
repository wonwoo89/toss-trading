import { useEffect, useRef, useState } from 'react';
import { formatKrw, formatUsd } from '../shared/lib/formatHoldings';
import { useAccountSummary } from '../shared/hooks/useAccountSummary';

/**
 * 모바일 전용 '내 계좌' 드롭다운. 좁은 화면에서 헤더가 2단으로 늘어나지 않도록
 * 총 계좌·환율을 버튼 하나로 함축하고, 클릭 시 드롭다운으로 펼친다.
 * (데스크톱은 CSS 로 숨기고 header-right 의 HeaderAccountBalance 인라인 표시를 쓴다.)
 */
export function HeaderAccountMenu() {
  const { isReady, exchangeRate, totalAccountValue, totalAccountValueKrw } = useAccountSummary();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  if (!isReady) return null;

  return (
    <div className="header-account-menu" ref={rootRef}>
      <button
        type="button"
        className="header-account-menu__trigger"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        내 계좌
        <svg
          className="header-account-menu__caret"
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="header-account-menu__panel" role="menu" aria-label="총 계좌 및 환율">
          <div className="header-account-menu__row">
            <span className="header-account-menu__label">환율</span>
            <span className="header-account-menu__rate">
              {exchangeRate !== undefined ? `$1 = ${formatKrw(exchangeRate)}` : '—'}
            </span>
          </div>
          <div className="header-account-menu__row">
            <span className="header-account-menu__label">총 계좌</span>
            <span className="header-account-menu__amount">
              <strong className="header-account-menu__usd">{formatUsd(totalAccountValue)}</strong>
              {totalAccountValueKrw !== undefined && (
                <span className="header-account-menu__krw">{formatKrw(totalAccountValueKrw)}</span>
              )}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

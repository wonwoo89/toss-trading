import { useEffect } from 'react';
import { BacktestPanel } from './BacktestPanel';

export function BacktestModal({ symbol, onClose }: { symbol: string; onClose: () => void }) {
  // Esc 로 닫기 + 배경 스크롤 잠금
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <div className="backtest-modal__overlay" onClick={onClose} role="presentation">
      <div
        className="backtest-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`${symbol} 신호 백테스트`}
      >
        <div className="backtest-modal__head">
          <h2 className="backtest-modal__title">백테스트 · {symbol}</h2>
          <button
            type="button"
            className="backtest-modal__close"
            onClick={onClose}
            aria-label="닫기"
          >
            ✕
          </button>
        </div>
        <div className="backtest-modal__body">
          <BacktestPanel key={symbol} initialSymbol={symbol} />
        </div>
      </div>
    </div>
  );
}

import { Link } from 'react-router-dom';
import { Typography } from '../shared/ui/Typography';

interface StockLabelProps {
  symbol: string;
  name?: string;
  to?: string;
  as?: 'heading' | 'inline';
  /** AI 자동매매(단일/다중) 실행 중 표시 — 티커명 좌상단 ★ 뱃지. */
  starred?: boolean;
}

export function StockLabel({ symbol, name, to, as = 'inline', starred = false }: StockLabelProps) {
  const displayName = name ?? symbol;
  const showTicker = Boolean(name);
  const className = `stock-label${as === 'heading' ? ' stock-label--heading' : ''}${starred ? ' stock-label--starred' : ''}`;

  const content = (
    <>
      {starred && (
        <span className="stock-label__star" title="AI 자동매매 실행 중" aria-label="AI 자동매매 실행 중">
          ★
        </span>
      )}
      <Typography size={as === 'heading' ? 20 : 14} className="stock-label__name">
        {displayName}
      </Typography>
      {showTicker && (
        <Typography size={12} className="stock-label__ticker">
          {symbol}
        </Typography>
      )}
    </>
  );

  if (to) {
    return (
      <Link to={to} className={`symbol-link ${className}`}>
        {content}
      </Link>
    );
  }

  if (as === 'heading') {
    return <h2 className={className}>{content}</h2>;
  }

  return <span className={className}>{content}</span>;
}

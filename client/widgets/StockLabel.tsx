import { Link } from 'react-router-dom';
import { Typography } from '../shared/ui/Typography';

interface StockLabelProps {
  symbol: string;
  name?: string;
  to?: string;
  as?: 'heading' | 'inline';
}

export function StockLabel({ symbol, name, to, as = 'inline' }: StockLabelProps) {
  const displayName = name ?? symbol;
  const showTicker = Boolean(name);
  const className = `stock-label${as === 'heading' ? ' stock-label--heading' : ''}`;

  const content = (
    <>
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

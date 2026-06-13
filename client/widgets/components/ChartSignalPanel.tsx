import { useMemo } from 'react';
import {
  buildChartSignalSnapshot,
  type ChartSignalBias,
  type ChartSignalLevel,
} from "../shared/lib/chartSignals';
import type { ChartCandle } from '../types';

interface OrderbookEntry {
  quantity: number;
}

interface ChartSignalPanelProps {
  candles: ChartCandle[];
  bids?: OrderbookEntry[];
  asks?: OrderbookEntry[];
  warnings?: string[];
  loading?: boolean;
}

function getLevelClassName(level: ChartSignalLevel) {
  switch (level) {
    case 'strong_buy':
      return 'chart-signal__badge--strong-buy';
    case 'weak_buy':
      return 'chart-signal__badge--weak-buy';
    case 'weak_sell':
      return 'chart-signal__badge--weak-sell';
    case 'strong_sell':
      return 'chart-signal__badge--strong-sell';
    default:
      return 'chart-signal__badge--neutral';
  }
}

function getMetricClassName(bias: ChartSignalBias) {
  switch (bias) {
    case 'bullish':
      return 'chart-signal__metric--bullish';
    case 'bearish':
      return 'chart-signal__metric--bearish';
    default:
      return 'chart-signal__metric--neutral';
  }
}

export function ChartSignalPanel({
  candles,
  bids = [],
  asks = [],
  warnings = [],
  loading = false,
}: ChartSignalPanelProps) {
  const snapshot = useMemo(
    () => buildChartSignalSnapshot({ candles, bids, asks, warnings }),
    [asks, bids, candles, warnings]
  );

  if (loading && candles.length === 0) {
    return (
      <div className="chart-signal" aria-live="polite">
        <p className="chart-signal__hint">신호 계산 중…</p>
      </div>
    );
  }

  return (
    <div className="chart-signal" aria-live="polite">
      <div className="chart-signal__header">
        <div className={`chart-signal__badge ${getLevelClassName(snapshot.level)}`}>
          {snapshot.label}
        </div>
        {!snapshot.insufficientData && (
          <span className="chart-signal__score">
            점수 {snapshot.score > 0 ? `+${snapshot.score}` : snapshot.score}
          </span>
        )}
        <p className="chart-signal__summary">{snapshot.summary}</p>
      </div>

      {snapshot.metrics.length > 0 && (
        <div className="chart-signal__metrics">
          {snapshot.metrics.map((metric) => (
            <span
              key={metric.id}
              className={`chart-signal__metric ${getMetricClassName(metric.bias)}`}
            >
              <span className="chart-signal__metric-label">{metric.label}</span>
              <span className="chart-signal__metric-value">{metric.value}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import {
  buildDayChangeMetric,
  buildDayPriceMetrics,
} from '../shared/lib/marketAnalytics';
import {
  buildBreakEvenMetric,
  resolveUsCommissionRatePercent,
} from '../shared/lib/commissionBreakEven';
import { buildHoldingPositionSnapshot } from '../shared/lib/holdingTarget';
import { type MicrostructureBias } from '../shared/lib/marketMicrostructure';
import { buildOrderExecutionMetrics } from '../shared/lib/orderExecutionContext';
import { formatUsd } from '../shared/lib/formatHoldings';
import { Typography } from '../shared/ui/Typography';
import { formatWarningSummary } from '../shared/lib/warningLabels';
import { resolveUsMarketSession, type UsMarketSessionKind } from '../shared/lib/usMarketCalendar';
import type {
  CandleInterval,
  ChartCandle,
  CommissionRaw,
  HoldingItem,
  Order,
  UsMarketCalendarRaw,
} from '../shared/types';

interface ChartMarketContextPanelProps {
  marketCalendar?: UsMarketCalendarRaw | null;
  calendarError?: string | null;
  calendarLoading?: boolean;
  candles?: ChartCandle[];
  candleInterval?: CandleInterval;
  currentPrice?: number;
  previousClose?: number;
  holding?: HoldingItem;
  profitLossRate?: number;
  targetProfitRatePercent: number;
  openOrders?: Order[];
  buyingPower?: number;
  sellableQuantity?: number;
  commissions?: CommissionRaw[];
  warnings?: string[];
}

interface ContextMetric {
  id: string;
  label: string;
  value: string;
  bias: MicrostructureBias;
}

function getSessionClassName(kind: UsMarketSessionKind) {
  switch (kind) {
    case 'day':
    case 'pre':
    case 'regular':
    case 'after':
      return 'market-context__session--open';
    case 'holiday':
      return 'market-context__session--holiday';
    case 'closed':
      return 'market-context__session--closed';
    default:
      return 'market-context__session--unknown';
  }
}

function getMetricClassName(bias: MicrostructureBias) {
  switch (bias) {
    case 'bullish':
      return 'market-context__metric--bullish';
    case 'bearish':
      return 'market-context__metric--bearish';
    default:
      return 'market-context__metric--neutral';
  }
}

function getProfitClassName(rate?: number) {
  if (rate === undefined || rate === 0) return 'market-context__metric--neutral';
  return rate > 0 ? 'market-context__metric--bullish' : 'market-context__metric--bearish';
}

function MetricRow({ label, metrics }: { label: string; metrics: ContextMetric[] }) {
  if (metrics.length === 0) return null;

  return (
    <div className="market-context__row">
      <Typography size={12} className="market-context__row-label">{label}</Typography>
      <div className="market-context__metrics">
        {metrics.map((metric) => (
          <span
            key={metric.id}
            className={`market-context__metric ${getMetricClassName(metric.bias)}`}
          >
            <Typography size={12} className="market-context__metric-label">{metric.label}</Typography>
            <Typography size={12} className="market-context__metric-value">{metric.value}</Typography>
          </span>
        ))}
      </div>
    </div>
  );
}

export function ChartMarketContextPanel({
  marketCalendar,
  calendarError,
  calendarLoading = false,
  candles = [],
  candleInterval = '1m',
  currentPrice,
  previousClose,
  holding,
  profitLossRate,
  targetProfitRatePercent,
  openOrders = [],
  buyingPower,
  sellableQuantity,
  commissions = [],
  warnings = [],
}: ChartMarketContextPanelProps) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const session = useMemo(
    () => resolveUsMarketSession(marketCalendar, now),
    [marketCalendar, now]
  );

  const commissionRatePercent = useMemo(
    () => resolveUsCommissionRatePercent(commissions),
    [commissions]
  );

  const position = useMemo(
    () =>
      buildHoldingPositionSnapshot({
        holding,
        currentPrice,
        profitLossRate,
        targetProfitRatePercent,
        commissionRatePercent,
      }),
    [currentPrice, holding, profitLossRate, targetProfitRatePercent, commissionRatePercent]
  );

  const dayPriceMetrics = useMemo(
    () => buildDayPriceMetrics(candles, candleInterval, currentPrice),
    [candleInterval, candles, currentPrice]
  );

  const dayChangeMetric = useMemo(
    () => buildDayChangeMetric(previousClose, currentPrice),
    [previousClose, currentPrice]
  );

  const orderExecutionMetrics = useMemo(
    () =>
      buildOrderExecutionMetrics({
        openOrders,
        buyingPower,
        sellableQuantity,
        holdingQuantity: holding?.quantity,
        currentPrice,
      }),
    [buyingPower, currentPrice, holding?.quantity, openOrders, sellableQuantity]
  );

  const breakEvenMetric = useMemo(
    () =>
      buildBreakEvenMetric({
        holdingAveragePrice: holding?.averagePrice,
        currentPrice,
        commissionRatePercent,
      }),
    [commissionRatePercent, currentPrice, holding?.averagePrice]
  );

  const warningSummary = formatWarningSummary(warnings);

  const sessionDetail = session.unavailable
    ? (calendarError ??
      (calendarLoading ? '장 정보 불러오는 중…' : '장 정보를 불러오지 못했습니다'))
    : [session.detail, session.countdown ? `남은 ${session.countdown}` : undefined]
        .filter(Boolean)
        .join(' · ');

  return (
    <div className="market-context" aria-live="polite">
      <div className="market-context__row">
        <Typography size={12} className="market-context__row-label">장 상태</Typography>
        <div className="market-context__row-content">
          <Typography size={12} className={`market-context__session ${getSessionClassName(session.kind)}`}>
            {session.label}
          </Typography>
          <Typography size={12} className="market-context__detail">{sessionDetail}</Typography>
        </div>
      </div>

      <MetricRow label="당일·변동" metrics={[dayChangeMetric, ...dayPriceMetrics]} />

      <MetricRow label="주문 실행" metrics={orderExecutionMetrics} />

      {position.visible && (
        <div className="market-context__row">
          <Typography size={12} className="market-context__row-label">보유 포지션</Typography>
          <div className="market-context__metrics">
            <span className="market-context__metric market-context__metric--neutral">
              <Typography size={12} className="market-context__metric-label">평단</Typography>
              <Typography size={12} className="market-context__metric-value">
                {formatUsd(position.averagePrice)}
              </Typography>
            </span>
            <span
              className={`market-context__metric ${getProfitClassName(position.profitLossRate)}`}
            >
              <Typography size={12} className="market-context__metric-label">실수익률</Typography>
              <Typography size={12} className="market-context__metric-value">{position.profitLossRateLabel}</Typography>
            </span>
            {breakEvenMetric && (
              <span
                className={`market-context__metric ${getMetricClassName(breakEvenMetric.bias)}`}
              >
                <Typography size={12} className="market-context__metric-label">{breakEvenMetric.label}</Typography>
                <Typography size={12} className="market-context__metric-value">{breakEvenMetric.value}</Typography>
              </span>
            )}
            <span
              className={`market-context__metric ${
                position.distanceToTargetPercent !== undefined &&
                position.distanceToTargetPercent <= 0
                  ? 'market-context__metric--bullish'
                  : 'market-context__metric--neutral'
              }`}
            >
              <Typography size={12} className="market-context__metric-label">
                목표 {position.targetProfitRatePercent}%
              </Typography>
              <Typography size={12} className="market-context__metric-value">{position.distanceToTargetLabel}</Typography>
            </span>
          </div>
        </div>
      )}

      {warningSummary && (
        <div className="market-context__row">
          <Typography size={12} className="market-context__row-label">종목 경고</Typography>
          <div className="market-context__row-content">
            <Typography size={12} className="market-context__warning">{warningSummary}</Typography>
          </div>
        </div>
      )}
    </div>
  );
}

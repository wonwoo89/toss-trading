import { useEffect, useMemo, useState } from 'react';
import {
  buildAtrMetric,
  buildDayPriceMetrics,
  buildSupportResistanceMetrics,
} from "../shared/lib/marketAnalytics';
import {
  buildCommissionBreakEvenMetrics,
  resolveUsCommissionRatePercent,
} from "../shared/lib/commissionBreakEven';
import { buildHoldingPositionSnapshot } from "../shared/lib/holdingTarget';
import {
  buildSpreadSnapshot,
  buildTradeFlowSnapshot,
  type MicrostructureBias,
} from "../shared/lib/marketMicrostructure';
import { buildOrderExecutionMetrics } from "../shared/lib/orderExecutionContext';
import { buildRecentOrderActivityMetric } from "../shared/lib/orderHistoryContext';
import { formatUsd } from "../shared/lib/formatHoldings';
import { formatWarningSummary } from "../shared/lib/warningLabels';
import { resolveUsMarketSession, type UsMarketSessionKind } from "../shared/lib/usMarketCalendar';
import type {
  CandleInterval,
  ChartCandle,
  CommissionRaw,
  HoldingItem,
  Order,
  UsMarketDayRaw,
} from '../types';

interface OrderbookEntry {
  price: number;
  quantity: number;
}

interface TradeEntry {
  price: number;
  quantity: number;
  timestamp: string;
}

interface ChartMarketContextPanelProps {
  marketDay?: UsMarketDayRaw;
  calendarError?: string | null;
  calendarLoading?: boolean;
  bids?: OrderbookEntry[];
  asks?: OrderbookEntry[];
  trades?: TradeEntry[];
  candles?: ChartCandle[];
  candleInterval?: CandleInterval;
  currentPrice?: number;
  holding?: HoldingItem;
  profitLossRate?: number;
  targetProfitRatePercent: number;
  openOrders?: Order[];
  closedOrders?: Order[];
  closedOrdersUnavailable?: boolean;
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
      <span className="market-context__row-label">{label}</span>
      <div className="market-context__metrics">
        {metrics.map((metric) => (
          <span
            key={metric.id}
            className={`market-context__metric ${getMetricClassName(metric.bias)}`}
          >
            <span className="market-context__metric-label">{metric.label}</span>
            <span className="market-context__metric-value">{metric.value}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function ChartMarketContextPanel({
  marketDay,
  calendarError,
  calendarLoading = false,
  bids = [],
  asks = [],
  trades = [],
  candles = [],
  candleInterval = '1m',
  currentPrice,
  holding,
  profitLossRate,
  targetProfitRatePercent,
  openOrders = [],
  closedOrders = [],
  closedOrdersUnavailable = false,
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

  const session = useMemo(() => resolveUsMarketSession(marketDay, now), [marketDay, now]);

  const spread = useMemo(() => buildSpreadSnapshot(bids, asks), [asks, bids]);
  const tradeFlow = useMemo(() => buildTradeFlowSnapshot(trades, bids, asks), [asks, bids, trades]);

  const position = useMemo(
    () =>
      buildHoldingPositionSnapshot({
        holding,
        currentPrice,
        profitLossRate,
        targetProfitRatePercent,
      }),
    [currentPrice, holding, profitLossRate, targetProfitRatePercent]
  );

  const commissionRatePercent = useMemo(
    () => resolveUsCommissionRatePercent(commissions),
    [commissions]
  );

  const dayPriceMetrics = useMemo(
    () => buildDayPriceMetrics(candles, candleInterval, currentPrice),
    [candleInterval, candles, currentPrice]
  );

  const supportResistanceMetrics = useMemo(() => buildSupportResistanceMetrics(candles), [candles]);

  const atrMetric = useMemo(() => buildAtrMetric(candles, currentPrice), [candles, currentPrice]);

  const orderExecutionMetrics = useMemo(
    () =>
      buildOrderExecutionMetrics({
        openOrders,
        buyingPower,
        sellableQuantity,
        currentPrice,
      }),
    [buyingPower, currentPrice, openOrders, sellableQuantity]
  );

  const commissionMetrics = useMemo(
    () =>
      buildCommissionBreakEvenMetrics({
        holdingAveragePrice: holding?.averagePrice,
        currentPrice,
        commissionRatePercent,
      }),
    [commissionRatePercent, currentPrice, holding?.averagePrice]
  );

  const orderHistoryMetric = useMemo(
    () => buildRecentOrderActivityMetric(openOrders, closedOrders, closedOrdersUnavailable),
    [closedOrders, closedOrdersUnavailable, openOrders]
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
        <span className="market-context__row-label">장 상태</span>
        <div className="market-context__row-content">
          <span className={`market-context__session ${getSessionClassName(session.kind)}`}>
            {session.label}
          </span>
          <span className="market-context__detail">{sessionDetail}</span>
        </div>
      </div>

      <MetricRow label="호가·체결" metrics={[spread, tradeFlow]} />

      <MetricRow
        label="당일·변동"
        metrics={[...dayPriceMetrics, atrMetric, ...supportResistanceMetrics]}
      />

      <MetricRow label="주문 실행" metrics={orderExecutionMetrics} />

      {position.visible && (
        <div className="market-context__row">
          <span className="market-context__row-label">보유 포지션</span>
          <div className="market-context__metrics">
            <span className="market-context__metric market-context__metric--neutral">
              <span className="market-context__metric-label">평단</span>
              <span className="market-context__metric-value">
                {formatUsd(position.averagePrice)}
              </span>
            </span>
            <span
              className={`market-context__metric ${getProfitClassName(position.profitLossRate)}`}
            >
              <span className="market-context__metric-label">실수익률</span>
              <span className="market-context__metric-value">{position.profitLossRateLabel}</span>
            </span>
            <span
              className={`market-context__metric ${
                position.distanceToTargetPercent !== undefined &&
                position.distanceToTargetPercent <= 0
                  ? 'market-context__metric--bullish'
                  : 'market-context__metric--neutral'
              }`}
            >
              <span className="market-context__metric-label">
                목표 {position.targetProfitRatePercent}%
              </span>
              <span className="market-context__metric-value">{position.distanceToTargetLabel}</span>
            </span>
          </div>
        </div>
      )}

      <MetricRow label="수수료·체결" metrics={[...commissionMetrics, orderHistoryMetric]} />

      {warningSummary && (
        <div className="market-context__row">
          <span className="market-context__row-label">종목 경고</span>
          <div className="market-context__row-content">
            <span className="market-context__warning">{warningSummary}</span>
          </div>
        </div>
      )}
    </div>
  );
}

import { buildChartSignalSnapshot } from './chartSignals';
import { formatUsd } from './formatHoldings';
import { buildSpreadSnapshot, buildTradeFlowSnapshot } from './marketMicrostructure';
import type { ChartCandle, HoldingItem, Order } from '../types';

const QUANTITY_SNAP_PERCENTS = [10, 25, 50, 75] as const;
const MAX_ENTRY_PERCENT = 75;
const MIN_ENTRY_PERCENT = 10;
const ATR_PERIOD = 14;
const HIGH_ATR_RATIO = 0.025;

export interface OrderQuantityRecommendationInput {
  side: 'BUY' | 'SELL';
  unitPrice?: number;
  maxQuantity?: number;
  buyingPower?: number;
  candles?: ChartCandle[];
  bids?: { price: number; quantity: number }[];
  asks?: { price: number; quantity: number }[];
  trades?: { price: number; quantity: number; timestamp: string }[];
  holding?: HoldingItem;
  openOrders?: Order[];
}

export interface OrderQuantityRecommendation {
  available: boolean;
  recommended: boolean;
  percent: number;
  quantity?: number;
  amountUsd?: number;
  quantityLabel: string;
  percentLabel: string;
  summary: string;
  reasons: string[];
  snapPercent?: (typeof QUANTITY_SNAP_PERCENTS)[number];
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function snapToNearestPercent(percent: number) {
  return QUANTITY_SNAP_PERCENTS.reduce((closest, candidate) =>
    Math.abs(candidate - percent) < Math.abs(closest - percent) ? candidate : closest
  );
}

function calculateAtr(candles: ChartCandle[]) {
  if (candles.length < ATR_PERIOD + 1) return undefined;

  const sorted = candles.slice().sort((a, b) => a.time - b.time);
  const trueRanges: number[] = [];

  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index];
    const previous = sorted[index - 1];
    trueRanges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      )
    );
  }

  const recent = trueRanges.slice(-ATR_PERIOD);
  return recent.reduce((sum, value) => sum + value, 0) / recent.length;
}

function getBasePercent(
  side: 'BUY' | 'SELL',
  level: ReturnType<typeof buildChartSignalSnapshot>['level']
) {
  if (side === 'BUY') {
    switch (level) {
      case 'strong_buy':
        return 50;
      case 'weak_buy':
        return 35;
      case 'neutral':
        return 25;
      case 'weak_sell':
        return 10;
      case 'strong_sell':
        return 0;
      default:
        return 25;
    }
  }

  switch (level) {
    case 'strong_sell':
      return 50;
    case 'weak_sell':
      return 35;
    case 'neutral':
      return 25;
    case 'weak_buy':
      return 10;
    case 'strong_buy':
      return 0;
    default:
      return 25;
  }
}

function getSignalReason(
  side: 'BUY' | 'SELL',
  level: ReturnType<typeof buildChartSignalSnapshot>['level']
) {
  if (side === 'BUY') {
    switch (level) {
      case 'strong_buy':
        return '강매수 신호';
      case 'weak_buy':
        return '약매수 신호';
      case 'weak_sell':
        return '약매도 신호 → 소량만';
      case 'strong_sell':
        return '강매도 신호';
      default:
        return '중립 신호';
    }
  }

  switch (level) {
    case 'strong_sell':
      return '강매도 신호';
    case 'weak_sell':
      return '약매도 신호';
    case 'weak_buy':
      return '약매수 신호 → 소량만';
    case 'strong_buy':
      return '강매수 신호';
    default:
      return '중립 신호';
  }
}

export function buildOrderQuantityRecommendation(
  input: OrderQuantityRecommendationInput
): OrderQuantityRecommendation {
  const {
    side,
    unitPrice,
    maxQuantity,
    buyingPower,
    candles = [],
    bids = [],
    asks = [],
    trades = [],
    holding,
    openOrders = [],
  } = input;

  if (maxQuantity === undefined || maxQuantity <= 0 || unitPrice === undefined || unitPrice <= 0) {
    return {
      available: false,
      recommended: false,
      percent: 0,
      quantityLabel: '—',
      percentLabel: '—',
      summary:
        side === 'BUY'
          ? '주문 가능 금액 또는 가격 정보를 불러오는 중입니다.'
          : '매도 가능 수량 정보를 불러오는 중입니다.',
      reasons: [],
    };
  }

  const signal = buildChartSignalSnapshot({ candles, bids, asks });
  const spread = buildSpreadSnapshot(bids, asks);
  const tradeFlow = buildTradeFlowSnapshot(trades, bids, asks);
  const atr = calculateAtr(candles);
  const atrRatio = atr !== undefined && unitPrice > 0 ? atr / unitPrice : undefined;

  let percent = getBasePercent(side, signal.level);
  const reasons: string[] = [getSignalReason(side, signal.level)];

  if (spread.spreadPercent !== undefined) {
    if (spread.spreadPercent > 0.15) {
      percent -= 10;
      reasons.push('스프레드 넓음');
    } else if (spread.spreadPercent < 0.05) {
      if (side === 'BUY' && percent > 0) {
        percent += 5;
        reasons.push('스프레드 좁음');
      } else if (side === 'SELL' && percent > 0) {
        percent += 5;
        reasons.push('스프레드 좁음');
      }
    }
  }

  if (side === 'BUY') {
    if (tradeFlow.buyRatio >= 0.6) {
      percent += 10;
      reasons.push('체결 매수 우세');
    } else if (tradeFlow.buyRatio <= 0.4) {
      percent -= 10;
      reasons.push('체결 매도 우세');
    }
  } else if (tradeFlow.buyRatio <= 0.4) {
    percent += 10;
    reasons.push('체결 매도 우세');
  } else if (tradeFlow.buyRatio >= 0.6) {
    percent -= 10;
    reasons.push('체결 매수 우세');
  }

  if (holding && holding.quantity > 0) {
    percent -= 15;
    reasons.push('기존 보유 → 분할');
  }

  const pendingSameSideOrders = openOrders.filter((order) => order.side === side).length;
  if (pendingSameSideOrders > 0) {
    percent -= 10;
    reasons.push('미체결 주문 존재');
  }

  if (atrRatio !== undefined && atrRatio >= HIGH_ATR_RATIO) {
    percent -= 10;
    reasons.push('변동성 큼');
  }

  if (signal.level === 'strong_sell' && side === 'BUY') {
    percent = 0;
  }
  if (signal.level === 'strong_buy' && side === 'SELL') {
    percent = 0;
  }

  percent = clamp(percent, 0, MAX_ENTRY_PERCENT);

  const recommended = percent >= MIN_ENTRY_PERCENT;
  const snapPercent = recommended ? snapToNearestPercent(percent) : undefined;
  const quantity = recommended ? Math.max(1, Math.floor(maxQuantity * (percent / 100))) : undefined;
  const amountUsd =
    quantity !== undefined ? quantity * unitPrice : buyingPower !== undefined ? 0 : undefined;

  const summary =
    side === 'BUY'
      ? recommended
        ? '신호·수급·보유 상태를 반영한 분할 매수 비중입니다.'
        : '현재 신호상 분할 매수 비중을 크게 권장하지 않습니다.'
      : recommended
        ? '신호·수급·보유 상태를 반영한 분할 매도 비중입니다.'
        : '현재 신호상 분할 매도 비중을 크게 권장하지 않습니다.';

  const uniqueReasons = [...new Set(reasons)];

  return {
    available: true,
    recommended,
    percent,
    quantity,
    amountUsd,
    quantityLabel: quantity !== undefined ? `${quantity.toLocaleString()}주` : '—',
    percentLabel: recommended ? `${percent}%` : '관망',
    summary,
    reasons: uniqueReasons.slice(0, 4),
    snapPercent,
  };
}

export function resolveOrderQuantity(
  quantityInput: string,
  recommendation: OrderQuantityRecommendation
): number | undefined {
  const parsed = Number(quantityInput);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  if (
    recommendation.available &&
    recommendation.recommended &&
    recommendation.quantity !== undefined &&
    recommendation.quantity > 0
  ) {
    return recommendation.quantity;
  }

  return undefined;
}

export function formatQuantityRecommendationValue(recommendation: OrderQuantityRecommendation) {
  if (!recommendation.recommended || recommendation.quantity === undefined) {
    return recommendation.percentLabel;
  }

  if (recommendation.amountUsd !== undefined) {
    return `${recommendation.quantityLabel} · ${recommendation.percentLabel} · ${formatUsd(recommendation.amountUsd)}`;
  }

  return `${recommendation.quantityLabel} · ${recommendation.percentLabel}`;
}

import { formatSignedPercent, formatUsd } from './formatHoldings';
import type { MicrostructureBias } from './marketMicrostructure';

export interface MarketMetric {
  id: string;
  label: string;
  value: string;
  bias: MicrostructureBias;
}

const DEFAULT_US_COMMISSION_RATE_PERCENT = 0.015;

function roundUsdPrice(price: number) {
  return Math.round(price * 100) / 100;
}

export function resolveUsCommissionRatePercent(
  commissions?: { marketCountry: string; commissionRate: string }[]
) {
  const usCommission = commissions?.find(
    (entry) => entry.marketCountry === 'US' || entry.marketCountry === 'USA'
  );
  const parsed = usCommission ? Number(usCommission.commissionRate) : undefined;
  return Number.isFinite(parsed) ? parsed! : DEFAULT_US_COMMISSION_RATE_PERCENT;
}

export function calculateRoundTripBreakEvenSellPrice(
  averagePrice: number,
  commissionRatePercent: number
) {
  const rate = commissionRatePercent / 100;
  return roundUsdPrice(averagePrice * (1 + rate * 2));
}

/**
 * 손익분기(왕복 수수료 반영 본전 매도가) 단일 지표. 보유(평단>0) 중일 때만 의미가 있어
 * 미보유 시 undefined 를 반환한다 — 호출부(보유 포지션 행)에서 보유 시에만 렌더한다.
 * 수수료율은 본 값에 이미 녹아 있으므로 별도 '수수료' 지표는 두지 않는다.
 */
export function buildBreakEvenMetric(params: {
  holdingAveragePrice?: number;
  currentPrice?: number;
  commissionRatePercent?: number;
}): MarketMetric | undefined {
  const { holdingAveragePrice, currentPrice, commissionRatePercent } = params;

  if (!holdingAveragePrice || holdingAveragePrice <= 0) return undefined;

  const rate = commissionRatePercent ?? DEFAULT_US_COMMISSION_RATE_PERCENT;
  const breakEvenPrice = calculateRoundTripBreakEvenSellPrice(holdingAveragePrice, rate);
  const distancePercent =
    currentPrice !== undefined && currentPrice > 0
      ? ((breakEvenPrice - currentPrice) / currentPrice) * 100
      : undefined;

  let value = formatUsd(breakEvenPrice);
  if (distancePercent !== undefined) {
    value =
      distancePercent <= 0 ? `도달 (${value})` : `+${distancePercent.toFixed(2)}% (${value})`;
  }

  return {
    id: 'break-even',
    label: '손익분기',
    value,
    bias: distancePercent !== undefined && distancePercent <= 0 ? 'bullish' : 'neutral',
  };
}

export function buildBuyBreakEvenHint(buyPrice: number, commissionRatePercent: number): string {
  const breakEven = calculateRoundTripBreakEvenSellPrice(buyPrice, commissionRatePercent);
  const markup = buyPrice > 0 ? ((breakEven - buyPrice) / buyPrice) * 100 : undefined;
  const markupText = markup !== undefined ? formatSignedPercent(markup / 100, markup) : undefined;
  return markupText
    ? `매수 후 손익분기 ${formatUsd(breakEven)} (${markupText})`
    : `매수 후 손익분기 ${formatUsd(breakEven)}`;
}

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

export function buildCommissionBreakEvenMetrics(params: {
  holdingAveragePrice?: number;
  currentPrice?: number;
  commissionRatePercent?: number;
}): MarketMetric[] {
  const { holdingAveragePrice, currentPrice, commissionRatePercent } = params;

  if (!holdingAveragePrice || holdingAveragePrice <= 0) {
    return [
      {
        id: 'commission-rate',
        label: '수수료',
        value:
          commissionRatePercent !== undefined
            ? `왕복 ${(commissionRatePercent * 2).toFixed(3)}%`
            : '—',
        bias: 'neutral',
      },
      {
        id: 'break-even',
        label: '손익분기',
        value: '보유 시 표시',
        bias: 'neutral',
      },
    ];
  }

  const rate = commissionRatePercent ?? DEFAULT_US_COMMISSION_RATE_PERCENT;
  const breakEvenPrice = calculateRoundTripBreakEvenSellPrice(holdingAveragePrice, rate);
  const distancePercent =
    currentPrice !== undefined && currentPrice > 0
      ? ((breakEvenPrice - currentPrice) / currentPrice) * 100
      : undefined;

  let breakEvenValue = formatUsd(breakEvenPrice);
  if (distancePercent !== undefined) {
    breakEvenValue =
      distancePercent <= 0
        ? `도달 (${breakEvenValue})`
        : `+${distancePercent.toFixed(2)}% (${breakEvenValue})`;
  }

  return [
    {
      id: 'commission-rate',
      label: '수수료',
      value: `왕복 ${(rate * 2).toFixed(3)}%`,
      bias: 'neutral',
    },
    {
      id: 'break-even',
      label: '손익분기',
      value: breakEvenValue,
      bias:
        distancePercent !== undefined ? (distancePercent <= 0 ? 'bullish' : 'neutral') : 'neutral',
    },
  ];
}

export function buildBuyBreakEvenHint(buyPrice: number, commissionRatePercent: number): string {
  const breakEven = calculateRoundTripBreakEvenSellPrice(buyPrice, commissionRatePercent);
  const markup = buyPrice > 0 ? ((breakEven - buyPrice) / buyPrice) * 100 : undefined;
  const markupText = markup !== undefined ? formatSignedPercent(markup / 100, markup) : undefined;
  return markupText
    ? `매수 후 손익분기 ${formatUsd(breakEven)} (${markupText})`
    : `매수 후 손익분기 ${formatUsd(breakEven)}`;
}

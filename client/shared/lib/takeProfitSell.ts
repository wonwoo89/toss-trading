import type { HoldingItem } from '../types';

/** 계좌 수수료율을 모를 때의 보수적 기본값(0.1%). 실제 요율은 commissionRatePercent 로 주입. */
const US_COMMISSION_RATE = 0.001;
const MIN_GROSS_PROFIT = 0.01;
const MAX_COST_RATIO = 0.99;

/** 요율(%) 입력을 소수 비율로 — 미지정/비정상이면 기본 0.1%. */
function toCommissionRate(commissionRatePercent?: number): number {
  if (commissionRatePercent === undefined || !Number.isFinite(commissionRatePercent)) {
    return US_COMMISSION_RATE;
  }
  return Math.min(Math.max(commissionRatePercent, 0), 5) / 100;
}

export interface TakeProfitCostContext {
  holdingQuantity?: number;
  grossProfitLoss?: number;
  profitLossCostDrag?: number;
  costCommission?: number;
  costTax?: number | null;
}

function roundUsdPrice(price: number) {
  // USD 지정가는 센트(0.01) 단위만 유효. 소수점은 내림 처리한다.
  return Math.floor(price * 100) / 100;
}

function ceilUsdPrice(price: number) {
  // 하한가는 올림 — 내림하면 목표 실수익에서 1센트만큼 미달할 수 있다. (fp 오차 보정 포함)
  return Math.ceil(price * 100 - 1e-9) / 100;
}

function scaleCostContext(
  costContext: TakeProfitCostContext | undefined,
  sellQuantity: number
): TakeProfitCostContext | undefined {
  if (!costContext) return undefined;

  const refQuantity = costContext.holdingQuantity ?? sellQuantity;
  if (refQuantity <= 0) return costContext;

  const scale = sellQuantity / refQuantity;
  if (scale === 1) return costContext;

  return {
    ...costContext,
    grossProfitLoss:
      costContext.grossProfitLoss !== undefined ? costContext.grossProfitLoss * scale : undefined,
    profitLossCostDrag:
      costContext.profitLossCostDrag !== undefined
        ? costContext.profitLossCostDrag * scale
        : undefined,
    costCommission:
      costContext.costCommission !== undefined ? costContext.costCommission * scale : undefined,
    costTax:
      costContext.costTax === null
        ? null
        : costContext.costTax !== undefined
          ? costContext.costTax * scale
          : undefined,
  };
}

function inferEffectiveTaxRate(
  grossProfit: number,
  costDrag: number,
  commission = 0,
  tax?: number | null
) {
  if (tax !== undefined && tax !== null && tax > 0) {
    const taxableProfit = grossProfit - commission;
    if (taxableProfit > MIN_GROSS_PROFIT) {
      return Math.min(tax / taxableProfit, 0.99);
    }
  }

  const impliedTax = costDrag - commission;
  if (impliedTax > 0) {
    const taxableProfit = grossProfit - commission;
    if (taxableProfit > MIN_GROSS_PROFIT) {
      return Math.min(impliedTax / taxableProfit, 0.99);
    }
  }

  return undefined;
}

function calculateWithCommissionAndTax(
  averagePrice: number,
  targetRate: number,
  commissionRate: number,
  taxRate: number
) {
  const denominator = 1 - commissionRate - taxRate;
  const safeDenominator = denominator > 0.01 ? denominator : 0.01;
  return (averagePrice * (targetRate + 1 - taxRate)) / safeDenominator;
}

export function getTakeProfitCostContext(holding?: HoldingItem): TakeProfitCostContext | undefined {
  if (!holding) return undefined;

  return {
    holdingQuantity: holding.quantity,
    grossProfitLoss: holding.grossProfitLoss,
    profitLossCostDrag: holding.profitLossCostDrag,
    costCommission: holding.costCommission,
    costTax: holding.costTax,
  };
}

export function calculateTakeProfitSellPrice(
  averagePrice: number,
  sellQuantity: number,
  targetAfterCostRatePercent: number,
  costContext?: TakeProfitCostContext,
  commissionRatePercent?: number
) {
  const targetRate = targetAfterCostRatePercent / 100;
  const commissionRate = toCommissionRate(commissionRatePercent);
  const purchaseAmount = sellQuantity * averagePrice;
  const targetAfterCostProfit = purchaseAmount * targetRate;
  const scaledCost = scaleCostContext(costContext, sellQuantity);

  // 수수료 하한가 — 왕복 수수료(매수·매도)를 내고도 목표 실수익이 남는 최소 매도가.
  // 비용 스냅샷이 비어 있거나(수수료를 0으로 오해석) 매도측 비용을 빠뜨려도
  // 목표 수익이 수수료에 잠식되지 않도록 모든 경로에 하한으로 적용한다.
  // net = P(1-r) - avg(1+r) ≥ avg·target → P ≥ avg(1+target+r)/(1-r)
  const commissionFloor = ceilUsdPrice(
    (averagePrice * (1 + targetRate + commissionRate)) / (1 - commissionRate)
  );

  const grossRef = scaledCost?.grossProfitLoss;
  const costDragRef =
    scaledCost?.profitLossCostDrag ??
    (scaledCost?.costCommission !== undefined
      ? scaledCost.costCommission + (scaledCost.costTax ?? 0)
      : undefined);

  if (
    grossRef !== undefined &&
    grossRef > MIN_GROSS_PROFIT &&
    costDragRef !== undefined &&
    costDragRef >= 0
  ) {
    const costRatio = Math.min(costDragRef / grossRef, MAX_COST_RATIO);
    const grossProfitNeeded = targetAfterCostProfit / (1 - costRatio);
    return Math.max(roundUsdPrice(averagePrice + grossProfitNeeded / sellQuantity), commissionFloor);
  }

  const commission = scaledCost?.costCommission ?? 0;
  const inferredTaxRate =
    grossRef !== undefined && costDragRef !== undefined
      ? inferEffectiveTaxRate(grossRef, costDragRef, commission, scaledCost?.costTax)
      : undefined;

  if (inferredTaxRate !== undefined) {
    return Math.max(
      roundUsdPrice(
        calculateWithCommissionAndTax(averagePrice, targetRate, commissionRate, inferredTaxRate)
      ),
      commissionFloor
    );
  }

  return commissionFloor;
}

export interface ExpectedSellProfit {
  /** 비용(수수료·세금) 반영 예상 실수익 금액(USD). */
  profit: number;
  /** 비용 반영 예상 실수익률(%) — 매입금액 대비. */
  ratePercent: number;
}

/**
 * 주어진 매도가로 전량/일부 매도했을 때의 예상 실수익(비용 반영)을 추정한다.
 *  1) 보유 손익 스냅샷의 실제 비용(수수료+제세금)이 있으면 '매도 금액 비례'로 스케일해 차감
 *     — referencePrice(스냅샷 기준가=현재가)로 매도가와의 비율을 보정. 손실 포지션에서도
 *     동작하며, 매도가=현재가일 때 주문폼 상단의 실제 수익률과 일치한다.
 *  2) 아니면(이익 포지션 한정) 비용 비율(costDrag/gross) 또는 수수료+추정 세율 모델
 *  3) 그것도 없으면 US 매도 수수료(0.1%)만 차감
 */
export function estimateNetSellProfit(
  averagePrice: number,
  sellQuantity: number,
  sellPrice: number,
  costContext?: TakeProfitCostContext,
  referencePrice?: number,
  commissionRatePercent?: number
): ExpectedSellProfit | undefined {
  if (!(averagePrice > 0) || !(sellQuantity > 0) || !(sellPrice > 0)) return undefined;

  const commissionRate = toCommissionRate(commissionRatePercent);
  const purchaseAmount = sellQuantity * averagePrice;
  const grossProfit = (sellPrice - averagePrice) * sellQuantity;
  const scaledCost = scaleCostContext(costContext, sellQuantity);

  const grossRef = scaledCost?.grossProfitLoss;
  const costDragRef =
    scaledCost?.profitLossCostDrag ??
    (scaledCost?.costCommission !== undefined
      ? scaledCost.costCommission + (scaledCost.costTax ?? 0)
      : undefined);

  let netProfit: number;
  if (
    costDragRef !== undefined &&
    costDragRef >= 0 &&
    referencePrice !== undefined &&
    referencePrice > 0
  ) {
    // 스냅샷 비용(수수료·제세금)은 매도 금액에 대체로 비례 — 기준가 대비 매도가 비율로 보정 차감.
    netProfit = grossProfit - costDragRef * (sellPrice / referencePrice);
  } else if (
    grossRef !== undefined &&
    grossRef > MIN_GROSS_PROFIT &&
    costDragRef !== undefined &&
    costDragRef >= 0
  ) {
    const costRatio = Math.min(costDragRef / grossRef, MAX_COST_RATIO);
    netProfit = grossProfit * (1 - costRatio);
  } else {
    const commission = scaledCost?.costCommission ?? 0;
    const inferredTaxRate =
      grossRef !== undefined && costDragRef !== undefined
        ? inferEffectiveTaxRate(grossRef, costDragRef, commission, scaledCost?.costTax)
        : undefined;

    if (inferredTaxRate !== undefined) {
      // 역산 모델: price = avg*(rate+1-tax)/(1-comm-tax) → rate 로 풀어 실수익률 산출.
      const rate =
        (sellPrice * (1 - commissionRate - inferredTaxRate)) / averagePrice -
        1 +
        inferredTaxRate;
      netProfit = purchaseAmount * rate;
    } else {
      // 기본: 왕복(매수·매도) 수수료 차감 — net = P(1-r) - avg(1+r).
      const rate = (sellPrice * (1 - commissionRate)) / averagePrice - 1 - commissionRate;
      netProfit = purchaseAmount * rate;
    }
  }

  return { profit: netProfit, ratePercent: (netProfit / purchaseAmount) * 100 };
}

export function resolveTakeProfitSellQuantity(
  boughtQuantity: number | undefined,
  baselineQuantity: number,
  nextQuantity: number | undefined
) {
  if (nextQuantity !== undefined) {
    const increase = Math.round((nextQuantity - baselineQuantity) * 10000) / 10000;
    if (increase > 0) {
      return increase;
    }
  }

  return boughtQuantity;
}

export function canPlaceTakeProfitSell(
  boughtQuantity: number | undefined,
  baselineQuantity: number,
  averagePrice?: number,
  nextQuantity?: number
) {
  const sellQuantity = resolveTakeProfitSellQuantity(
    boughtQuantity,
    baselineQuantity,
    nextQuantity
  );

  return Boolean(averagePrice && averagePrice > 0 && sellQuantity && sellQuantity > 0);
}

const TAKE_PROFIT_FILL_DELAYS_MS = [2000, 3000, 5000, 7000] as const;

export async function waitForTakeProfitSnapshot<
  T extends {
    holding?: { quantity?: number; averagePrice?: number };
  },
>(
  fetchSnapshot: () => Promise<T>,
  boughtQuantity: number | undefined,
  baselineQuantity: number,
  initialState: T
): Promise<T> {
  if (
    canPlaceTakeProfitSell(
      boughtQuantity,
      baselineQuantity,
      initialState.holding?.averagePrice,
      initialState.holding?.quantity
    )
  ) {
    return initialState;
  }

  let latest = initialState;

  for (const delayMs of TAKE_PROFIT_FILL_DELAYS_MS) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    latest = await fetchSnapshot();

    if (
      canPlaceTakeProfitSell(
        boughtQuantity,
        baselineQuantity,
        latest.holding?.averagePrice,
        latest.holding?.quantity
      )
    ) {
      return latest;
    }
  }

  return latest;
}

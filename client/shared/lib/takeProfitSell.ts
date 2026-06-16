import type { HoldingItem } from '../types';

const US_COMMISSION_RATE = 0.001;
const MIN_GROSS_PROFIT = 0.01;
const MAX_COST_RATIO = 0.99;

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
  costContext?: TakeProfitCostContext
) {
  const targetRate = targetAfterCostRatePercent / 100;
  const purchaseAmount = sellQuantity * averagePrice;
  const targetAfterCostProfit = purchaseAmount * targetRate;
  const scaledCost = scaleCostContext(costContext, sellQuantity);

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
    return roundUsdPrice(averagePrice + grossProfitNeeded / sellQuantity);
  }

  const commission = scaledCost?.costCommission ?? 0;
  const inferredTaxRate =
    grossRef !== undefined && costDragRef !== undefined
      ? inferEffectiveTaxRate(grossRef, costDragRef, commission, scaledCost?.costTax)
      : undefined;

  if (inferredTaxRate !== undefined) {
    return roundUsdPrice(
      calculateWithCommissionAndTax(averagePrice, targetRate, US_COMMISSION_RATE, inferredTaxRate)
    );
  }

  return roundUsdPrice((averagePrice * (1 + targetRate)) / (1 - US_COMMISSION_RATE));
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

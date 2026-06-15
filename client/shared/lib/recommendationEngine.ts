import { buildChartSignalSnapshot } from './chartSignals';
import { buildLimitPriceRecommendation } from './limitPriceRecommendation';
import { buildOrderQuantityRecommendation } from './orderQuantityRecommendation';
import { buildTakeProfitRateRecommendation } from './takeProfitRateRecommendation';
import type { ChartSignalInput, ChartSignalSnapshot } from './chartSignals';
import type { LimitPriceRecommendation, OrderbookLevel, TradeTick } from './limitPriceRecommendation';
import type { OrderQuantityRecommendation } from './orderQuantityRecommendation';
import type { TakeProfitRateRecommendation } from './takeProfitRateRecommendation';
import type { CandleInterval, ChartCandle, HoldingItem, Order } from '../types';

/**
 * 모든 주문 추천 계산을 한 번에 수행하기 위한 입력. OrderForm 이 개별 build* 함수에 넘기던
 * 필드들을 합쳤다. 모든 필드가 직렬화 가능해 Web Worker 로 그대로 전달할 수 있다.
 */
export interface OrderRecommendationInput {
  side: 'BUY' | 'SELL';
  currentPrice?: number;
  candles?: ChartCandle[];
  candleInterval?: CandleInterval;
  bids?: OrderbookLevel[];
  asks?: OrderbookLevel[];
  trades?: TradeTick[];
  holding?: HoldingItem;
  takeProfitRatePercent?: number;
  commissionRatePercent?: number;
  openOrders?: Order[];
  effectiveOrderPrice?: number;
  maxOrderQuantity?: number;
  buyMaxForRec?: number;
  sellMaxForRec?: number;
  buyingPower?: number;
}

/** OrderForm 이 화면에 사용하던 7개 추천 결과 묶음. */
export interface OrderRecommendationResult {
  limitPriceRecommendation: LimitPriceRecommendation;
  takeProfitRateRecommendation: TakeProfitRateRecommendation;
  quantityRecommendation: OrderQuantityRecommendation;
  buyQuantityRec: OrderQuantityRecommendation;
  sellQuantityRec: OrderQuantityRecommendation;
  buyLimitPriceRec: LimitPriceRecommendation;
  sellLimitPriceRec: LimitPriceRecommendation;
}

/** 차트 신호 스냅샷 계산 (ChartSignalPanel 용). */
export function computeChartSignal(input: ChartSignalInput): ChartSignalSnapshot {
  return buildChartSignalSnapshot(input);
}

/**
 * 7개 추천을 한 번의 호출(=한 번의 워커 왕복)으로 계산한다. 기존 OrderForm 의 useMemo 들과
 * 동일한 인자 구성을 그대로 옮겨 동작이 바뀌지 않도록 했다.
 */
export function computeOrderRecommendations(
  input: OrderRecommendationInput
): OrderRecommendationResult {
  const {
    side,
    currentPrice,
    candleInterval,
    holding,
    takeProfitRatePercent,
    commissionRatePercent,
    effectiveOrderPrice,
    maxOrderQuantity,
    buyMaxForRec,
    sellMaxForRec,
    buyingPower,
  } = input;

  // 배열 필드는 ?? [] 로 정규화한다. destructuring 기본값(= [])은 undefined 만 막고 null 은
  // 통과시켜 빌더의 .map/.slice/.filter 에서 throw 하는데, 종목 전환 과도기엔 null 이 들어올 수 있다.
  const candles = input.candles ?? [];
  const bids = input.bids ?? [];
  const asks = input.asks ?? [];
  const trades = input.trades ?? [];
  const openOrders = input.openOrders ?? [];

  const limitPriceRecommendation = buildLimitPriceRecommendation({
    side,
    currentPrice,
    candles,
    candleInterval,
    bids,
    asks,
    trades,
    holding,
    targetProfitRatePercent: takeProfitRatePercent,
    commissionRatePercent,
    openOrders,
  });

  const takeProfitRateRecommendation = buildTakeProfitRateRecommendation({
    candles,
    currentPrice,
    bids,
    asks,
  });

  const quantityRecommendation = buildOrderQuantityRecommendation({
    side,
    unitPrice: effectiveOrderPrice,
    maxQuantity: maxOrderQuantity,
    buyingPower,
    candles,
    bids,
    asks,
    trades,
    holding,
    openOrders,
  });

  const buyQuantityRec = buildOrderQuantityRecommendation({
    side: 'BUY',
    unitPrice: effectiveOrderPrice,
    maxQuantity: buyMaxForRec,
    buyingPower,
    candles,
    bids,
    asks,
    trades,
    holding,
    openOrders,
  });

  const sellQuantityRec = buildOrderQuantityRecommendation({
    side: 'SELL',
    unitPrice: effectiveOrderPrice,
    maxQuantity: sellMaxForRec,
    buyingPower,
    candles,
    bids,
    asks,
    trades,
    holding,
    openOrders,
  });

  const buyLimitPriceRec = buildLimitPriceRecommendation({
    side: 'BUY',
    currentPrice,
    candles,
    candleInterval,
    bids,
    asks,
    trades,
    holding,
    targetProfitRatePercent: takeProfitRatePercent,
    commissionRatePercent,
    openOrders,
  });

  const sellLimitPriceRec = buildLimitPriceRecommendation({
    side: 'SELL',
    currentPrice,
    candles,
    candleInterval,
    bids,
    asks,
    trades,
    holding,
    targetProfitRatePercent: takeProfitRatePercent,
    commissionRatePercent,
    openOrders,
  });

  return {
    limitPriceRecommendation,
    takeProfitRateRecommendation,
    quantityRecommendation,
    buyQuantityRec,
    sellQuantityRec,
    buyLimitPriceRec,
    sellLimitPriceRec,
  };
}

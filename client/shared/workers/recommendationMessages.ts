import type { ChartSignalInput, ChartSignalSnapshot } from '../lib/chartSignals';
import type { OrderRecommendationInput, OrderRecommendationResult } from '../lib/recommendationEngine';

/** 워커가 처리하는 메서드별 payload/result 타입 매핑. */
export interface RecommendationMethodMap {
  chartSignal: { payload: ChartSignalInput; result: ChartSignalSnapshot };
  orderRecs: { payload: OrderRecommendationInput; result: OrderRecommendationResult };
}

export type RecommendationMethod = keyof RecommendationMethodMap;

/** 메인 → 워커 요청. method 기준 판별 유니온이라 워커에서 payload 가 정확히 좁혀진다. */
export type WorkerRequest = {
  [M in RecommendationMethod]: {
    id: number;
    method: M;
    payload: RecommendationMethodMap[M]['payload'];
  };
}[RecommendationMethod];

/** 워커 → 메인 응답. */
export type WorkerResponse = {
  [M in RecommendationMethod]: {
    id: number;
    method: M;
    result: RecommendationMethodMap[M]['result'];
  };
}[RecommendationMethod];

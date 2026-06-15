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

/** 워커 → 메인 성공 응답. */
export type WorkerSuccessResponse = {
  [M in RecommendationMethod]: {
    id: number;
    method: M;
    result: RecommendationMethodMap[M]['result'];
  };
}[RecommendationMethod];

/** 워커 → 메인 에러 응답. compute 가 throw 해도 요청이 반드시 settle 되도록 id 와 함께 회신한다. */
export interface WorkerErrorResponse {
  id: number;
  error: string;
}

/** 워커 → 메인 응답(성공 | 에러). 모든 요청은 둘 중 하나로 반드시 응답된다. */
export type WorkerResponse = WorkerSuccessResponse | WorkerErrorResponse;

/** 에러 응답 판별자. */
export function isWorkerErrorResponse(response: WorkerResponse): response is WorkerErrorResponse {
  return 'error' in response;
}

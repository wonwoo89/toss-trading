/// <reference lib="webworker" />
import { setIndicatorBackend } from '../lib/indicatorBackend';
import { computeChartSignal, computeOrderRecommendations } from '../lib/recommendationEngine';
import {
  atrFromCandlesWasm,
  bollingerWindowsWasm,
  initIndicatorsWasm,
} from '../lib/wasm/indicators';
import type { WorkerRequest, WorkerResponse } from './recommendationMessages';

// 워커 안에서만 WASM 지표 백엔드를 등록한다(메인 스레드는 JS 유지). 준비 전에는 래퍼가
// null 을 돌려줘 JS 폴백되므로, init 완료를 기다리지 않고 바로 등록·시작한다.
setIndicatorBackend({
  bollingerWindows: bollingerWindowsWasm,
  atrFromCandles: atrFromCandlesWasm,
});
void initIndicatorsWasm();

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  let response: WorkerResponse;
  if (request.method === 'chartSignal') {
    response = {
      id: request.id,
      method: 'chartSignal',
      result: computeChartSignal(request.payload),
    };
  } else {
    response = {
      id: request.id,
      method: 'orderRecs',
      result: computeOrderRecommendations(request.payload),
    };
  }

  ctx.postMessage(response);
});

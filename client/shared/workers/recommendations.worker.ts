/// <reference lib="webworker" />
import { computeChartSignal, computeOrderRecommendations } from '../lib/recommendationEngine';
import type { WorkerRequest, WorkerResponse } from './recommendationMessages';

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

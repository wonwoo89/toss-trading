import {
  isWorkerErrorResponse,
  type RecommendationMethod,
  type RecommendationMethodMap,
  type WorkerRequest,
  type WorkerResponse,
} from './recommendationMessages';

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, PendingCall>();

function rejectAll(reason: unknown) {
  for (const [id, call] of pending) {
    call.reject(reason);
    pending.delete(id);
  }
}

/**
 * 추천 계산 워커를 지연 생성하는 모듈 싱글톤. 앱 전체가 워커 1개(스레드 1개)를 공유한다.
 * Worker 미지원 환경(SSR/테스트)이면 null 을 돌려 호출 측이 동기 폴백하도록 한다.
 */
function getWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (worker) return worker;

  try {
    const instance = new Worker(new URL('./recommendations.worker.ts', import.meta.url), {
      type: 'module',
    });

    instance.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      const call = pending.get(response.id);
      if (!call) return;
      pending.delete(response.id);
      // 에러 응답이면 reject → 호출 측(useWorkerCompute)이 동기 계산으로 폴백한다.
      if (isWorkerErrorResponse(response)) {
        call.reject(new Error(response.error));
      } else {
        call.resolve(response.result);
      }
    });

    instance.addEventListener('error', () => {
      // 워커 자체 오류: 대기 중 호출을 reject 해 동기 폴백을 유도하고 워커를 재생성 가능 상태로.
      rejectAll(new Error('recommendation worker error'));
      worker = null;
    });

    instance.addEventListener('messageerror', () => {
      // 구조화 복제(직렬화) 실패: id 를 알 수 없으므로 대기 호출을 모두 reject 해 폴백을 유도한다.
      rejectAll(new Error('recommendation worker message deserialization failed'));
    });

    worker = instance;
  } catch {
    worker = null;
  }

  return worker;
}

export function isWorkerAvailable(): boolean {
  return typeof Worker !== 'undefined';
}

/**
 * 워커에 한 건의 계산을 요청한다. 요청 id 로 응답을 매칭한다. 워커가 없으면 null 을 반환해
 * 호출 측이 동기 계산으로 폴백할 수 있게 한다.
 */
export function callWorker<M extends RecommendationMethod>(
  method: M,
  payload: RecommendationMethodMap[M]['payload']
): Promise<RecommendationMethodMap[M]['result']> | null {
  const instance = getWorker();
  if (!instance) return null;

  const id = nextId++;
  const request = { id, method, payload } as WorkerRequest;

  return new Promise<RecommendationMethodMap[M]['result']>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    instance.postMessage(request);
  });
}

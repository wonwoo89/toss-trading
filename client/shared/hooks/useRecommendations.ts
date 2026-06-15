import { useEffect, useRef, useState } from 'react';
import {
  computeChartSignal,
  computeOrderRecommendations,
  type OrderRecommendationInput,
  type OrderRecommendationResult,
} from '../lib/recommendationEngine';
import type { ChartSignalInput, ChartSignalSnapshot } from '../lib/chartSignals';
import { callWorker } from '../workers/createWorkerClient';

/**
 * 순수 계산을 Web Worker 로 오프로딩하는 범용 훅.
 *
 * - 첫 렌더는 동기 계산으로 즉시 값을 채워 깜빡임을 막는다.
 * - 이후 input 이 바뀌면 워커에 위임하고, 결과가 올 때까지 직전 값을 유지한다(no-flicker).
 * - 워커 처리 중 새 input 이 오면 큐잉하지 않고 "마지막 input 만 보존 후 완료 시 재전송"
 *   (usePolling 의 pendingForceRefresh 패턴과 동일).
 * - 더 새로운 요청이 떠 있으면 늦게 도착한 결과는 폐기(stale-drop).
 * - 워커 미지원/오류 시 동기 계산으로 폴백한다.
 *
 * runner/syncCompute 는 모듈 레벨의 안정 참조여야 한다(아래 export 훅 참고). 그래야 effect
 * 의존성에 넣어도 input 변경 시에만 재실행된다.
 *
 * 주의: 호출 측은 input 을 useMemo 로 안정화해 실제 의존성이 바뀔 때만 재계산되게 해야 한다.
 */
function useWorkerCompute<P, R>(
  input: P,
  runner: (payload: P) => Promise<R> | null,
  syncCompute: (payload: P) => R
): R {
  const [result, setResult] = useState<R>(() => syncCompute(input));
  const inFlightRef = useRef(false);
  const pendingRef = useRef<{ payload: P } | null>(null);
  const seqRef = useRef(0);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  useEffect(() => {
    // 동기 폴백이 throw 해도(잘못된 입력 등) 직전 결과를 유지하고 inFlight 흐름을 깨지 않는다.
    const setFromSyncCompute = (payload: P) => {
      try {
        setResult(syncCompute(payload));
      } catch {
        // 폴백 실패: 직전 결과 유지. (다음 input 변경 시 다시 계산을 시도한다.)
      }
    };

    const run = (payload: P) => {
      const promise = runner(payload);

      if (!promise) {
        // 워커 미지원: 비동기 마이크로태스크로 폴백 계산(effect 내 동기 setState 회피).
        void Promise.resolve().then(() => {
          if (!cancelledRef.current) {
            setFromSyncCompute(payload);
          }
        });
        return;
      }

      inFlightRef.current = true;
      const seq = ++seqRef.current;

      promise
        .then((value) => {
          if (!cancelledRef.current && seq === seqRef.current) {
            setResult(value);
          }
        })
        .catch(() => {
          if (!cancelledRef.current && seq === seqRef.current) {
            setFromSyncCompute(payload);
          }
        })
        .finally(() => {
          inFlightRef.current = false;
          const next = pendingRef.current;
          if (next && !cancelledRef.current) {
            pendingRef.current = null;
            run(next.payload);
          }
        });
    };

    if (inFlightRef.current) {
      pendingRef.current = { payload: input };
    } else {
      run(input);
    }
  }, [input, runner, syncCompute]);

  return result;
}

// 모듈 레벨 안정 참조: 렌더마다 새 함수가 만들어지지 않아 effect 의존성으로 안전하다.
const runChartSignal = (payload: ChartSignalInput) => callWorker('chartSignal', payload);
const runOrderRecs = (payload: OrderRecommendationInput) => callWorker('orderRecs', payload);

/** 차트 신호 스냅샷을 워커에서 계산한다. */
export function useChartSignal(input: ChartSignalInput): ChartSignalSnapshot {
  return useWorkerCompute(input, runChartSignal, computeChartSignal);
}

/** 7개 주문 추천을 워커에서 한 번에 계산한다. */
export function useOrderRecommendations(
  input: OrderRecommendationInput
): OrderRecommendationResult {
  return useWorkerCompute(input, runOrderRecs, computeOrderRecommendations);
}

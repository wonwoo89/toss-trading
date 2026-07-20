import { getAutoTradeSettings, saveAutoTradeSettings } from './autoTradeSettings';

const EVENT_NAME = 'toss-trading:apply-auto-trade-settings';

export interface AutoTradeApplyPayload {
  targetPercent: number;
  stopLossPercent: number;
  /** 로그 표기용 출처(예: '백테스트 최적화'). */
  source?: string;
}

/**
 * 백테스트(모달/페이지) → AI 자동매매 패널로 목표/손절 설정을 적용하는 경량 버스.
 * 패널이 마운트돼 있으면 즉시 반영(이벤트), 아니면 localStorage 저장으로 다음 마운트에 반영.
 */
export function applyAutoTradeSettings(payload: AutoTradeApplyPayload) {
  if (!(payload.targetPercent > 0) || !(payload.stopLossPercent > 0)) return;
  // 영속 우선 — 패널 미마운트 상태(백테스트 페이지 단독)에서도 다음 진입 시 반영된다.
  const current = getAutoTradeSettings();
  saveAutoTradeSettings({
    ...current,
    targetPercent: payload.targetPercent,
    stopLossPercent: payload.stopLossPercent,
  });
  window.dispatchEvent(new CustomEvent<AutoTradeApplyPayload>(EVENT_NAME, { detail: payload }));
}

export function subscribeAutoTradeApply(
  handler: (payload: AutoTradeApplyPayload) => void
): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<AutoTradeApplyPayload>).detail;
    if (detail && detail.targetPercent > 0 && detail.stopLossPercent > 0) handler(detail);
  };
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}

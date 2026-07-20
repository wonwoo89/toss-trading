import { api } from '../api/client';
import { getAutoTradeSettings, saveAutoTradeSettings } from './autoTradeSettings';

const EVENT_NAME = 'toss-trading:apply-auto-trade-settings';

export interface AutoTradeApplyPayload {
  targetPercent: number;
  stopLossPercent: number;
  /** 적용 대상 종목 — 서버 AI 매매가 이 종목으로 실행 중일 때만 서버 설정도 갱신. */
  symbol?: string;
  /** 로그 표기용 출처(예: '백테스트 최적화'). */
  source?: string;
}

/**
 * 백테스트(모달/페이지) → AI 자동매매 패널로 목표/손절 설정을 적용하는 경량 버스.
 * 패널이 마운트돼 있으면 즉시 반영(이벤트), 아니면 localStorage 저장으로 다음 마운트에 반영.
 * 서버 AI 매매(auto)가 같은 종목으로 실행 중이면 서버 설정도 즉시 갱신한다 — 패널이
 * 미마운트 상태거나, 재마운트 시 서버값으로 되덮는 동기화가 있어도 적용값이 유지되게.
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

  // 서버 AI 매매 동기화(베스트에포트) — 실행 중 + 종목 일치 시에만.
  void (async () => {
    try {
      const st = (await api.getLiveTraderStatus()).result;
      if (!st.config.enabled) return;
      if (payload.symbol && st.config.symbol !== payload.symbol.toUpperCase()) return;
      await api.saveLiveTraderConfig({
        ...st.config,
        targetPercent: payload.targetPercent,
        stopLossPercent: payload.stopLossPercent,
      });
    } catch {
      // 서버 미접속 등 — 로컬 적용만으로 충분(다음 설정 변경 시 재시도됨).
    }
  })();
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

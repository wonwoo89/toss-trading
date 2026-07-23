import { useEffect, useRef } from 'react';
import { api } from '../shared/api/client';
import { unwrapResult } from '../shared/lib/parse';
import { useToast } from '../app/providers/ToastContext';

const POLL_MS = 5000;
/** SSE 가 이 시간 안에 열리지 않으면 폴링 폴백으로 전환. */
const SSE_OPEN_TIMEOUT_MS = 8000;

interface OrderEventPayload {
  id: number;
  source: 'single' | 'multi';
  kind: 'order' | 'cancel' | 'fill';
  text: string;
}

/**
 * 서버 자동매매 주문 알림 — 접수/취소/체결을 토스트로 띄운다.
 * 1순위 SSE(/api/notifications/stream): 발생 즉시 푸시. 이벤트 id 기반이라 끊겼다
 * 붙으면 브라우저가 Last-Event-ID 로 놓친 이벤트를 리플레이받는다.
 * SSE 를 못 여는 환경에서는 5초 폴링으로 자동 폴백한다.
 */
export function OrderEventToasts() {
  const { showToast } = useToast();
  const seenRef = useRef(0); // 마지막 처리 이벤트 id — SSE/폴링 공용 중복 방지 커서

  useEffect(() => {
    let stopped = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const handle = (e: OrderEventPayload) => {
      if (e.id <= seenRef.current) return;
      seenRef.current = e.id;
      const prefix = e.source === 'single' ? '[단일]' : '[다종목]';
      showToast(`${prefix} ${e.text}`, e.kind === 'fill' ? 'success' : 'info');
    };

    const startPolling = () => {
      if (pollTimer || stopped) return;
      const poll = async () => {
        try {
          const res = unwrapResult(await api.getOrderNotifications(seenRef.current));
          if (stopped || !res) return;
          if (seenRef.current > 0) for (const e of res.events) handle(e);
          seenRef.current = Math.max(seenRef.current, res.latest);
        } catch {
          // 다음 주기에 재시도
        }
      };
      void poll();
      pollTimer = setInterval(() => void poll(), POLL_MS);
    };

    let source: EventSource | null = null;
    try {
      source = new EventSource('/api/notifications/stream');
    } catch {
      startPolling();
      return () => {
        stopped = true;
        if (pollTimer) clearInterval(pollTimer);
      };
    }

    // 일정 시간 내 연결 실패 → 폴백. (열린 뒤 끊김은 EventSource 가 자동 재접속 + 리플레이)
    const openGuard = setTimeout(() => {
      if (source && source.readyState !== EventSource.OPEN) {
        source.close();
        source = null;
        startPolling();
      }
    }, SSE_OPEN_TIMEOUT_MS);

    source.addEventListener('order', (ev) => {
      try {
        handle(JSON.parse((ev as MessageEvent<string>).data) as OrderEventPayload);
      } catch {
        // 형식 오류 무시
      }
    });

    return () => {
      stopped = true;
      clearTimeout(openGuard);
      source?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [showToast]);

  return null;
}

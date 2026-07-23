import { useEffect, useRef } from 'react';
import { api } from '../shared/api/client';
import { unwrapResult } from '../shared/lib/parse';
import { useToast } from '../app/providers/ToastContext';

const POLL_MS = 5000;

/**
 * 서버 자동매매 주문 알림 — 단일종목·백그라운드 엔진의 주문 접수/취소/체결을
 * 폴링으로 받아 토스트로 띄운다(앱이 열려 있는 동안). 첫 폴링은 커서만 받아
 * 과거 이벤트를 재생하지 않고, 이후 새 이벤트만 표시한다.
 */
export function OrderEventToasts() {
  const { showToast } = useToast();
  const cursorRef = useRef(0);

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const res = unwrapResult(await api.getOrderNotifications(cursorRef.current));
        if (stopped || !res) return;
        if (cursorRef.current > 0) {
          for (const e of res.events) {
            const prefix = e.source === 'single' ? '[단일]' : '[다종목]';
            showToast(`${prefix} ${e.text}`, e.kind === 'fill' ? 'success' : 'info');
          }
        }
        cursorRef.current = res.latest;
      } catch {
        // 폴링 실패는 조용히 다음 주기에 재시도
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [showToast]);

  return null;
}

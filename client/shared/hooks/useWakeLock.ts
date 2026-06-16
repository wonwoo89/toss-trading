import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'toss-trading:wake-lock';

// Wake Lock 타입은 환경별 lib 차이가 있어 최소 인터페이스로 직접 정의(빌드 안전).
interface WakeLockSentinelLike {
  release: () => Promise<void>;
}
interface WakeLockLike {
  request: (type: 'screen') => Promise<WakeLockSentinelLike>;
}

function getWakeLock(): WakeLockLike | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
}

/**
 * Screen Wake Lock — PWA 에서 화면이 꺼지지 않게 유지. (Android Chrome, iOS Safari 16.4+)
 * - 토글 상태는 localStorage 에 영속.
 * - 백그라운드로 가면 OS 가 lock 을 자동 해제하므로, 다시 보일 때(visibilitychange) 재획득한다.
 * - 미지원 환경이면 supported=false (호출 측이 UI 를 숨김).
 */
export function useWakeLock() {
  const supported = getWakeLock() !== undefined;
  const [enabled, setEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const sentinelRef = useRef<WakeLockSentinelLike | null>(null);

  const acquire = useCallback(async () => {
    const wl = getWakeLock();
    if (!wl || document.visibilityState !== 'visible' || sentinelRef.current) return;
    try {
      sentinelRef.current = await wl.request('screen');
    } catch {
      // 권한/정책으로 거부될 수 있음 — 무시(토글로 다시 시도 가능)
    }
  }, []);

  const release = useCallback(async () => {
    try {
      await sentinelRef.current?.release();
    } catch {
      // ignore
    }
    sentinelRef.current = null;
  }, []);

  // enabled 변화에 따라 획득/해제
  useEffect(() => {
    if (!supported) return;
    if (enabled) void acquire();
    else void release();
    return () => {
      void release();
    };
  }, [enabled, supported, acquire, release]);

  // 백그라운드 → 포그라운드 복귀 시 재획득 (lock 자동 해제 대응)
  useEffect(() => {
    if (!supported) return;
    const onVisibility = () => {
      if (enabled && document.visibilityState === 'visible') {
        void acquire();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [enabled, supported, acquire]);

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, next ? 'true' : 'false');
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  return { supported, enabled, toggle };
}

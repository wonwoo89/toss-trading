import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'toss-trading:wake-lock';

// Wake Lock 타입은 환경별 lib 차이가 있어 최소 인터페이스로 직접 정의(빌드 안전).
interface WakeLockSentinelLike {
  release: () => Promise<void>;
  addEventListener: (type: 'release', listener: () => void) => void;
  removeEventListener: (type: 'release', listener: () => void) => void;
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
  // 동시에 두 번 request 하지 않도록(enabled 효과 + visibilitychange 레이스) 진행 중 플래그.
  const acquiringRef = useRef(false);
  // 최신 enabled 를 이벤트 콜백(release 재획득 등)에서 참조하기 위한 ref.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const acquireRef = useRef<() => Promise<void>>(async () => {});

  const acquire = useCallback(async () => {
    const wl = getWakeLock();
    if (!wl || document.visibilityState !== 'visible' || sentinelRef.current || acquiringRef.current)
      return;
    acquiringRef.current = true;
    try {
      const sentinel = await wl.request('screen');
      sentinelRef.current = sentinel;
      // 화면이 꺼지거나 백그라운드로 가면 OS 가 lock 을 자동 해제하며 release 이벤트를 쏜다.
      // iOS 는 저전력 모드·알림 배너 등으로 '보이는 중'에도 해제하는 경우가 있어,
      // ref 를 비운 뒤 여전히 사용 중(enabled)이고 화면이 보이면 잠시 후 바로 재획득한다.
      const onRelease = () => {
        sentinel.removeEventListener('release', onRelease);
        if (sentinelRef.current === sentinel) sentinelRef.current = null;
        if (enabledRef.current && document.visibilityState === 'visible') {
          // 즉시 재요청하면 OS 가 다시 거부하는 루프가 될 수 있어 짧게 쉼
          setTimeout(() => {
            if (enabledRef.current) void acquireRef.current();
          }, 1000);
        }
      };
      sentinel.addEventListener('release', onRelease);
    } catch {
      // 권한/정책으로 거부될 수 있음 — 무시(워치독·복귀 이벤트가 재시도)
    } finally {
      acquiringRef.current = false;
    }
  }, []);
  acquireRef.current = acquire;

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

  // 백그라운드 → 포그라운드 복귀 시 재획득 (lock 자동 해제 대응).
  // iOS PWA 는 잠금화면 빠른 복귀 등에서 visibilitychange 가 누락되는 경우가 있어
  // focus/pageshow 에서도 재획득을 시도한다(가드가 있어 중복 요청은 안 됨).
  useEffect(() => {
    if (!supported) return;
    const onResume = () => {
      if (enabled && document.visibilityState === 'visible') {
        void acquire();
      }
    };
    document.addEventListener('visibilitychange', onResume);
    window.addEventListener('focus', onResume);
    window.addEventListener('pageshow', onResume);
    return () => {
      document.removeEventListener('visibilitychange', onResume);
      window.removeEventListener('focus', onResume);
      window.removeEventListener('pageshow', onResume);
    };
  }, [enabled, supported, acquire]);

  // 워치독 — 이벤트를 하나도 못 받고 lock 이 풀린 경우까지 커버(20초 주기).
  useEffect(() => {
    if (!supported || !enabled) return;
    const timer = setInterval(() => {
      if (!sentinelRef.current && document.visibilityState === 'visible') {
        void acquire();
      }
    }, 20_000);
    return () => clearInterval(timer);
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

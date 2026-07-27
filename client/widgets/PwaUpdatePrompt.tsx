import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { Typography } from '../shared/ui/Typography';

/** 업데이트 시도 흔적 — 활성화가 끝나기 전에 리로드돼도 다음 로드에서 이어서 적용하기 위함. */
const ATTEMPT_KEY = 'toss-trading:pwa-update-attempted';

function getAttempted(): boolean {
  try {
    return sessionStorage.getItem(ATTEMPT_KEY) === '1';
  } catch {
    return false;
  }
}

function setAttempted(on: boolean) {
  try {
    if (on) sessionStorage.setItem(ATTEMPT_KEY, '1');
    else sessionStorage.removeItem(ATTEMPT_KEY);
  } catch {
    // ignore
  }
}

/**
 * PWA 새 배포 알림 배너. 서비스워커가 새 버전을 감지하면(needRefresh) 배너를 띄우고,
 * '업데이트'를 누르면 새 SW 를 즉시 적용(skipWaiting)하고 페이지를 리로드한다.
 * 앱이 다시 보일 때(복귀/포커스) 능동적으로 업데이트를 확인해 새 배포를 빨리 감지한다.
 *
 * iOS 에서 워커 활성화가 리로드보다 늦으면 이전 버전이 다시 뜨며 배너가 반복 노출되는
 * 문제가 있어: ① 강제 리로드 폴백을 8초로 늦추고(정상 경로는 controllerchange 가 리로드)
 * ② 시도 흔적(sessionStorage)을 남겨 리로드 후에도 대기 워커가 남아 있으면
 *    자동으로 skipWaiting 을 재요청해 루프를 끊는다.
 */
export function PwaUpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      // 직전 시도가 활성화 전에 리로드된 경우 — 대기 워커에 스킵을 다시 요청(배너 루프 방지).
      if (getAttempted()) {
        if (registration.waiting) {
          registration.waiting.postMessage({ type: 'SKIP_WAITING' });
        } else {
          setAttempted(false); // 이미 새 워커로 넘어옴 — 흔적 정리
        }
      }
      const check = () => {
        if (document.visibilityState === 'visible') void registration.update();
      };
      document.addEventListener('visibilitychange', check);
      window.addEventListener('focus', check);
    },
  });

  // 업데이트 시도 중 새 워커가 컨트롤러를 넘겨받으면 즉시 리로드해 새 버전으로 전환.
  // (시도 흔적이 있을 때만 — 다른 이유의 controllerchange 로 사용 중 화면이 날아가지 않게)
  useEffect(() => {
    const sw = navigator.serviceWorker;
    if (!sw) return;
    const onControllerChange = () => {
      if (!getAttempted()) return;
      setAttempted(false);
      window.location.reload();
    };
    sw.addEventListener('controllerchange', onControllerChange);
    return () => sw.removeEventListener('controllerchange', onControllerChange);
  }, []);

  const [updating, setUpdating] = useState(false);
  const applyUpdate = () => {
    if (updating) return;
    setUpdating(true);
    setAttempted(true);
    void updateServiceWorker(true).catch(() => undefined);
    // 폴백: 8초 내 워커 전환(controllerchange → 리로드)이 없으면 강제 리로드.
    // 리로드 후에도 대기 워커가 남아 있으면 위 onRegisteredSW 재시도 로직이 이어받는다.
    setTimeout(() => window.location.reload(), 8000);
  };

  if (!needRefresh) return null;

  return (
    <div className="pwa-update" role="alert" aria-live="polite">
      <Typography size={12} className="pwa-update__text">새 버전이 배포되었어요.</Typography>
      <button
        type="button"
        className="pwa-update__btn"
        disabled={updating}
        onClick={applyUpdate}
      >
        {updating ? '적용 중…' : '업데이트'}
      </button>
      <button
        type="button"
        className="pwa-update__close"
        aria-label="닫기"
        onClick={() => setNeedRefresh(false)}
      >
        ×
      </button>
    </div>
  );
}

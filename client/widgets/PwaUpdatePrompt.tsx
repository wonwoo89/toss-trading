import { useRegisterSW } from 'virtual:pwa-register/react';

/**
 * PWA 새 배포 알림 배너. 서비스워커가 새 버전을 감지하면(needRefresh) 배너를 띄우고,
 * '업데이트'를 누르면 새 SW 를 즉시 적용(skipWaiting)하고 페이지를 리로드한다.
 * 앱이 다시 보일 때(복귀/포커스) 능동적으로 업데이트를 확인해 새 배포를 빨리 감지한다.
 */
export function PwaUpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      const check = () => {
        if (document.visibilityState === 'visible') void registration.update();
      };
      document.addEventListener('visibilitychange', check);
      window.addEventListener('focus', check);
    },
  });

  if (!needRefresh) return null;

  return (
    <div className="pwa-update" role="alert" aria-live="polite">
      <span className="pwa-update__text">새 버전이 배포되었어요.</span>
      <button
        type="button"
        className="pwa-update__btn"
        onClick={() => updateServiceWorker(true)}
      >
        업데이트
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

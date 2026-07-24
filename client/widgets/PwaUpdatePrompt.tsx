import { useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { Typography } from '../shared/ui/Typography';

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

  // 적용 중 표시 + 강제 리로드 폴백 — iOS 에서 skipWaiting/controllerchange 가
  // 무반응이면(새 워커 설치 중 등) 버튼이 '안 눌린 것'처럼 보이는 문제를 막는다.
  const [updating, setUpdating] = useState(false);
  const applyUpdate = () => {
    if (updating) return;
    setUpdating(true);
    void updateServiceWorker(true).catch(() => undefined);
    // 2.5초 내 워커 교체 리로드가 일어나지 않으면 강제 새로고침(새 워커가 활성화돼 있으면 새 버전으로 뜬다).
    setTimeout(() => window.location.reload(), 2500);
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

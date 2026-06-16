import { useWakeLock } from '../shared/hooks/useWakeLock';

/** 화면 꺼짐 방지(Screen Wake Lock) 토글 — 테마 토글과 같은 헤더 컨트롤 스타일. */
export function WakeLockToggle() {
  const { supported, enabled, toggle } = useWakeLock();

  if (!supported) return null;

  return (
    <button
      type="button"
      className={`theme-toggle wake-lock-toggle${enabled ? ' is-active' : ''}`}
      onClick={toggle}
      aria-pressed={enabled}
      aria-label={enabled ? '화면 꺼짐 방지 끄기' : '화면 꺼짐 방지 켜기'}
      title={enabled ? '화면 켜둠: ON' : '화면 켜둠: OFF'}
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    </button>
  );
}

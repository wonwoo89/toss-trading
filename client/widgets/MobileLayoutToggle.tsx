import { useSyncExternalStore } from 'react';
import {
  getMobileLayoutV2,
  setMobileLayoutV2,
  subscribeMobileLayout,
} from '../shared/lib/mobileLayoutPreference';

/**
 * 모바일 신규 레이아웃(v2, 하단 탭) 전환 토글 — 헤더 컨트롤(모바일 전용, 데스크톱은 CSS 숨김).
 * 켜면 하단 탭(차트/주문/호가/자산) 구조, 끄면 기존 세로 스크롤 구조.
 */
export function MobileLayoutToggle() {
  const enabled = useSyncExternalStore(subscribeMobileLayout, getMobileLayoutV2);

  return (
    <button
      type="button"
      className={`theme-toggle mobile-layout-toggle${enabled ? ' is-active' : ''}`}
      onClick={() => setMobileLayoutV2(!enabled)}
      aria-pressed={enabled}
      aria-label={enabled ? '기존 레이아웃으로 전환' : '새 레이아웃(하단 탭)으로 전환'}
      title={enabled ? '새 레이아웃: ON (탭 구조)' : '새 레이아웃: OFF'}
    >
      <svg
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M3 15h18M9 15v6M15 15v6" />
      </svg>
    </button>
  );
}

export type MobileTab = 'chart' | 'order' | 'book' | 'assets';

interface MobileTabBarProps {
  active: MobileTab;
  onChange: (tab: MobileTab) => void;
}

const ICON_PROPS = {
  width: 22,
  height: 22,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

const TABS: { id: MobileTab; label: string; icon: React.ReactNode }[] = [
  {
    id: 'chart',
    label: '차트',
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M7 4v3M7 15v3M7 7h2v8H5V7h2ZM17 6v3M17 17v3M17 9h2v8h-4V9h2Z" />
      </svg>
    ),
  },
  {
    id: 'order',
    label: '주문',
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M13 2 5 14h6l-1 8 8-12h-6l1-8Z" />
      </svg>
    ),
  },
  {
    id: 'book',
    label: '호가',
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M4 6h10M4 10h7M4 14h10M4 18h7M18 8l3 3-3 3" />
      </svg>
    ),
  },
  {
    id: 'assets',
    label: '자산',
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z" />
        <path d="M16 12h5v4h-5a2 2 0 1 1 0-4Z" />
      </svg>
    ),
  },
];

/**
 * 모바일 신규 레이아웃(v2)의 하단 고정 탭바. 차트/주문/호가/자산 화면 전환.
 * PWA 홈 인디케이터를 피하도록 safe-area-inset-bottom 패딩 포함(CSS).
 */
export function MobileTabBar({ active, onChange }: MobileTabBarProps) {
  return (
    <nav className="mobile-tab-bar" aria-label="화면 전환">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={`mobile-tab-bar__tab${active === tab.id ? ' is-active' : ''}`}
          aria-pressed={active === tab.id}
          onClick={() => onChange(tab.id)}
        >
          {tab.icon}
          <span>{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}

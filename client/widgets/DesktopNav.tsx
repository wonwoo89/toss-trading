import { useLocation, useNavigate } from 'react-router-dom';
import { Typography } from '../shared/ui/Typography';

const ICON_PROPS = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

type NavId = 'trade' | 'server-ai' | 'backtest';

const ITEMS: { id: NavId; label: string; path: string; icon: React.ReactNode }[] = [
  {
    id: 'trade',
    label: '투자',
    path: '/',
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M7 4v3M7 15v3M7 7h2v8H5V7h2ZM17 6v3M17 17v3M17 9h2v8h-4V9h2Z" />
      </svg>
    ),
  },
  {
    id: 'server-ai',
    label: 'AI 매매',
    path: '/server-ai',
    icon: (
      <svg {...ICON_PROPS}>
        <rect x="5" y="8" width="14" height="10" rx="2.5" />
        <path d="M12 8V5M12 5h.01M9 12.5h.01M15 12.5h.01M9.5 15.5h5" />
      </svg>
    ),
  },
  {
    id: 'backtest',
    label: '백테스트',
    path: '/backtest',
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M4 5v6h6M4.5 11A8 8 0 1 1 6 16" />
        <path d="M12 8v4l3 2" />
      </svg>
    ),
  },
];

function activeIdFromPath(pathname: string): NavId {
  if (pathname.startsWith('/server-ai')) return 'server-ai';
  if (pathname.startsWith('/backtest')) return 'backtest';
  return 'trade'; // '/', '/portfolio', '/stock/*'
}

/**
 * 데스크톱 전용 플로팅 하단 내비게이션 — 화면 하단 중앙의 필(pill).
 * 투자(트레이딩) / 백그라운드 AI / 백테스트 세 화면을 전환한다.
 * 모바일(≤1100px)은 기존 하단 탭바(MobileTabBar)를 쓰므로 CSS 로 숨긴다.
 */
export function DesktopNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const active = activeIdFromPath(location.pathname);

  return (
    <nav className="desktop-nav" aria-label="주요 화면 전환">
      {ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`desktop-nav__item${active === item.id ? ' is-active' : ''}`}
          aria-pressed={active === item.id}
          onClick={() => {
            // '투자'는 / 로 이동 — StockPage 가 마지막 선택 종목으로 자동 리다이렉트한다.
            if (active !== item.id) navigate(item.path);
          }}
        >
          {item.icon}
          <Typography size={12}>{item.label}</Typography>
        </button>
      ))}
    </nav>
  );
}

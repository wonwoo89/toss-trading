import { HeaderAccountBalance } from './HeaderAccountBalance';
import { HeaderAccountMenu } from './HeaderAccountMenu';
import { KeyboardShortcutsHelp } from './KeyboardShortcutsHelp';
import { SymbolSearch } from './SymbolSearch';
import { ThemeToggle } from './ThemeToggle';
import { WakeLockToggle } from './WakeLockToggle';

export function Header() {
  return (
    <header className="header">
      <div className="header-left">
        <div className="brand">
          <img className="brand__logo" src="/favicon.svg" alt="Toss Trading" />
        </div>
        <div className="header-left-actions">
          <SymbolSearch />
          <ThemeToggle />
          <WakeLockToggle />
          {/* 백테스트/백그라운드 AI 진입은 하단 내비게이션으로 이동 —
              데스크톱=DesktopNav(플로팅), 모바일=MobileTabBar/설정 탭 */}
          {/* 모바일 전용: 화면꺼짐 방지 버튼 옆 '내 계좌' 드롭다운 (데스크톱은 CSS 로 숨김) */}
          <HeaderAccountMenu />
          <KeyboardShortcutsHelp />
        </div>
      </div>

      <div className="header-right">
        <HeaderAccountBalance />
      </div>
    </header>
  );
}

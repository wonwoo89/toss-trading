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

import { HeaderAccountBalance } from './HeaderAccountBalance';
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
          <KeyboardShortcutsHelp />
        </div>
      </div>

      <div className="header-right">
        <HeaderAccountBalance />
      </div>
    </header>
  );
}

import { HeaderAccountBalance } from './HeaderAccountBalance';
import { SymbolSearch } from './SymbolSearch';
import { ThemeToggle } from './ThemeToggle';

export function Header() {
  return (
    <header className="header">
      <div className="header-left">
        <div className="brand">
          <h1>Toss Trading</h1>
        </div>
        <div className="header-left-actions">
          <SymbolSearch />
          <ThemeToggle />
        </div>
      </div>

      <div className="header-right">
        <HeaderAccountBalance />
      </div>
    </header>
  );
}

import { HeaderAccountBalance } from './HeaderAccountBalance';
import { SymbolSearch } from './SymbolSearch';
import { ThemeToggle } from './ThemeToggle';

export function Header() {
  return (
    <header className="header">
      <div className="header-left">
        <HeaderAccountBalance />
      </div>

      <div className="header-right">
        <div className="brand">
          <h1>Toss Trading</h1>
        </div>
        <div className="header-right-actions">
          <SymbolSearch />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

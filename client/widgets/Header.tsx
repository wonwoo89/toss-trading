import { HeaderAccountBalance } from './HeaderAccountBalance';
import { SymbolSearch } from './SymbolSearch';
import { ThemeToggle } from './ThemeToggle';

export function Header() {
  return (
    <header className="header">
      <div className="header-left">
        <div className="brand">
          <h1>toss-trading</h1>
        </div>
        <SymbolSearch />
        <ThemeToggle />
      </div>

      <div className="header-right">
        <HeaderAccountBalance />
      </div>
    </header>
  );
}

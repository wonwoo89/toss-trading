import { HeaderAccountBalance } from './HeaderAccountBalance';
import { SymbolSearch } from './SymbolSearch';
import { ThemeToggle } from './ThemeToggle';

export function Header() {
  return (
    <header className="header">
      <div className="brand">
        <h1>toss-trading</h1>
        <ThemeToggle />
      </div>

      <div className="header-actions">
        <HeaderAccountBalance />
        <SymbolSearch />
      </div>
    </header>
  );
}

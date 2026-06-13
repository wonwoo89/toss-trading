import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../shared/api/client';
import { setLastSelectedSymbol } from '../shared/lib/lastSymbolPreference';
import type { StockInfo } from '../shared/types';

function looksLikeTicker(value: string) {
  return /^[A-Za-z0-9.^\-]+$/.test(value);
}

function isEditableElementFocused() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  if (active.id === 'symbol-search') return true;
  if (active.isContentEditable) return true;

  const tag = active.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function SymbolSearch() {
  const navigate = useNavigate();
  const { symbol: routeSymbol } = useParams<{ symbol?: string }>();
  const [searchInput, setSearchInput] = useState('');
  const [suggestions, setSuggestions] = useState<StockInfo[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [isSearching, setIsSearching] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const requestSeqRef = useRef(0);

  useEffect(() => {
    if (routeSymbol) {
      setSearchInput(routeSymbol.toUpperCase());
    }
  }, [routeSymbol]);

  useEffect(() => {
    const handleFocusShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== '/' && event.code !== 'Slash') return;
      if (isEditableElementFocused()) return;

      event.preventDefault();
      const input = inputRef.current;
      if (!input) return;

      input.focus();
      input.select();
    };

    window.addEventListener('keydown', handleFocusShortcut);
    return () => window.removeEventListener('keydown', handleFocusShortcut);
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
        setActiveIndex(-1);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    const query = searchInput.trim();
    clearTimeout(debounceRef.current);

    if (!query) {
      setSuggestions([]);
      setIsOpen(false);
      setActiveIndex(-1);
      setIsSearching(false);
      return;
    }

    const seq = ++requestSeqRef.current;
    setIsSearching(true);

    debounceRef.current = setTimeout(() => {
      void api
        .searchStocks(query)
        .then((response) => {
          if (seq !== requestSeqRef.current) return;
          setSuggestions(response.result);
          setIsOpen(response.result.length > 0);
          setActiveIndex(-1);
        })
        .catch(() => {
          if (seq !== requestSeqRef.current) return;
          setSuggestions([]);
          setIsOpen(false);
        })
        .finally(() => {
          if (seq !== requestSeqRef.current) return;
          setIsSearching(false);
        });
    }, 250);

    return () => clearTimeout(debounceRef.current);
  }, [searchInput]);

  const goToSymbol = (symbol: string) => {
    const normalized = symbol.toUpperCase();
    setSearchInput(normalized);
    setSuggestions([]);
    setIsOpen(false);
    setActiveIndex(-1);
    setLastSelectedSymbol(normalized);
    navigate(`/stock/${normalized}`);
  };

  const resolveSymbol = async (): Promise<string | null> => {
    const trimmed = searchInput.trim();
    if (!trimmed) return null;

    if (looksLikeTicker(trimmed)) {
      return trimmed.toUpperCase();
    }

    if (suggestions.length > 0) {
      return suggestions[0].symbol;
    }

    try {
      const response = await api.searchStocks(trimmed, 1);
      return response.result[0]?.symbol ?? null;
    } catch {
      return null;
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const symbol = await resolveSymbol();
    if (!symbol) return;
    goToSymbol(symbol);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isOpen || suggestions.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((prev) => (prev + 1) % suggestions.length);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((prev) => (prev <= 0 ? suggestions.length - 1 : prev - 1));
      return;
    }

    if (event.key === 'Enter' && activeIndex >= 0) {
      event.preventDefault();
      goToSymbol(suggestions[activeIndex].symbol);
      return;
    }

    if (event.key === 'Escape') {
      setIsOpen(false);
      setActiveIndex(-1);
    }
  };

  return (
    <form className="symbol-search symbol-search--header" onSubmit={handleSubmit}>
      <div className="symbol-search-field" ref={containerRef}>
        <input
          ref={inputRef}
          id="symbol-search"
          aria-label="종목 검색"
          aria-autocomplete="list"
          aria-expanded={isOpen}
          aria-controls="symbol-search-listbox"
          role="combobox"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          onFocus={() => {
            if (suggestions.length > 0) setIsOpen(true);
          }}
          onKeyDown={handleKeyDown}
          placeholder="AAPL 또는 애플"
          autoComplete="off"
        />
        {isOpen && suggestions.length > 0 && (
          <ul className="symbol-search-suggestions" id="symbol-search-listbox" role="listbox">
            {suggestions.map((stock, index) => (
              <li key={stock.symbol} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  className={index === activeIndex ? 'is-active' : undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => goToSymbol(stock.symbol)}
                >
                  <span className="symbol-search-suggestions__symbol">{stock.symbol}</span>
                  <span className="symbol-search-suggestions__name">{stock.name}</span>
                  {stock.englishName && stock.englishName !== stock.name && (
                    <span className="symbol-search-suggestions__english">{stock.englishName}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        {isSearching && searchInput.trim() && (
          <span className="symbol-search-status" aria-live="polite">
            검색 중…
          </span>
        )}
      </div>
    </form>
  );
}

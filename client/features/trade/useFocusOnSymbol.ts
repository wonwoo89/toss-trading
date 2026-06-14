import { useEffect } from 'react';
import type { RefObject } from 'react';

export function useFocusOnSymbol(
  symbol: string | undefined,
  layoutRef: RefObject<HTMLElement | null>
) {
  useEffect(() => {
    const searchInput = document.getElementById('symbol-search');
    if (searchInput instanceof HTMLElement) {
      searchInput.blur();
    }

    if (symbol) {
      const isMobile = window.matchMedia('(max-width: 1100px)').matches;
      if (isMobile) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }

    layoutRef.current?.focus({ preventScroll: true });
  }, [symbol]);
}

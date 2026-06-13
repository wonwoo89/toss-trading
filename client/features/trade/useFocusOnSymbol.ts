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
    layoutRef.current?.focus({ preventScroll: true });
  }, [symbol]);
}

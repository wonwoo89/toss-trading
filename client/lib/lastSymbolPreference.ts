const STORAGE_KEY = 'toss-trading:last-symbol';

function normalizeSymbol(symbol: string) {
  const trimmed = symbol.trim().toUpperCase();
  if (!trimmed || !/^[A-Z0-9.^\-]+$/.test(trimmed)) return null;
  return trimmed;
}

export function getLastSelectedSymbol() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    return normalizeSymbol(stored);
  } catch {
    return null;
  }
}

export function setLastSelectedSymbol(symbol: string) {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return;

  try {
    localStorage.setItem(STORAGE_KEY, normalized);
  } catch {
    // ignore storage write errors
  }
}

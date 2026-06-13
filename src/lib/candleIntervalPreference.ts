import { CANDLE_INTERVALS, type CandleInterval } from '../types';

const STORAGE_KEY = 'toss-trading:candle-interval';

const VALID_INTERVALS = new Set<CandleInterval>(CANDLE_INTERVALS.map((option) => option.value));

export function getStoredCandleInterval(): CandleInterval {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && VALID_INTERVALS.has(stored as CandleInterval)) {
      return stored as CandleInterval;
    }
  } catch {
    // ignore storage read errors
  }

  return '1m';
}

export function setStoredCandleInterval(interval: CandleInterval) {
  try {
    localStorage.setItem(STORAGE_KEY, interval);
  } catch {
    // ignore storage write errors
  }
}

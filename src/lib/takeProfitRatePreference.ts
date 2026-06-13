const STORAGE_KEY = 'toss-trading:take-profit-rate';
const DEFAULT_RATE = 3;
export const TAKE_PROFIT_RATE_OPTIONS = [1, 3, 5, 10, 20] as const;

export type TakeProfitRateOption = (typeof TAKE_PROFIT_RATE_OPTIONS)[number];

const VALID_RATES = TAKE_PROFIT_RATE_OPTIONS;

function normalizeRate(rate: number): TakeProfitRateOption {
  return VALID_RATES.includes(rate as TakeProfitRateOption)
    ? (rate as TakeProfitRateOption)
    : DEFAULT_RATE;
}

export function getStoredTakeProfitRate(): TakeProfitRateOption {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return DEFAULT_RATE;
    return normalizeRate(Number(stored));
  } catch {
    return DEFAULT_RATE;
  }
}

export function setStoredTakeProfitRate(rate: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(normalizeRate(rate)));
  } catch {
    // ignore storage write errors
  }
}

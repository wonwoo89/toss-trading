const NUMBER_LOCALE = 'en-US';

export function formatUsd(value?: number) {
  if (value === undefined) return '—';
  return `$${value.toLocaleString(NUMBER_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatKrw(value?: number) {
  if (value === undefined) return '—';
  return `₩${Math.round(value).toLocaleString('ko-KR')}`;
}

/** 통화별 금액 포맷. KRW=정수 원(₩), 그 외=USD($, 소수 2자리). 기본 USD. */
export function formatMoney(value?: number, currency?: string) {
  return currency === 'KRW' ? formatKrw(value) : formatUsd(value);
}

/** 부호 포함 통화별 금액 포맷(손익 등). */
export function formatSignedMoney(value?: number, currency?: string) {
  if (value === undefined) return '—';
  if (currency === 'KRW') {
    const sign = value < 0 ? '-' : '+';
    return `${sign}₩${Math.abs(Math.round(value)).toLocaleString('ko-KR')}`;
  }
  return formatSignedUsd(value);
}

export function formatQuantity(value?: number) {
  if (value === undefined) return '—';

  const hasFraction = Math.abs(value % 1) > 0;
  return value.toLocaleString(NUMBER_LOCALE, {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 4,
  });
}

export function formatSignedUsd(value?: number) {
  if (value === undefined) return '—';

  const formatted = Math.abs(value).toLocaleString(NUMBER_LOCALE, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  if (value > 0) return `+$${formatted}`;
  if (value < 0) return `-$${formatted}`;
  return `+$${formatted}`;
}

export function formatSignedPercent(rate?: number, amount?: number) {
  if (rate === undefined) return null;

  const direction = amount ?? rate;
  const sign = direction > 0 ? '+' : direction < 0 ? '-' : '+';
  const absRate = Math.abs(rate);
  const percent = absRate <= 1 ? absRate * 100 : absRate;

  return `${sign}${percent.toFixed(2)}%`;
}

export function formatProfitLoss(amount?: number, rate?: number) {
  if (amount === undefined && rate === undefined) return '—';

  const amountText = formatSignedUsd(amount);
  const rateText = formatSignedPercent(rate, amount);

  return rateText ? `${amountText} (${rateText})` : amountText;
}

export function getKrProfitLossClass(value?: number) {
  if (value === undefined || value === 0) return undefined;
  return value > 0 ? 'kr-profit' : 'kr-loss';
}

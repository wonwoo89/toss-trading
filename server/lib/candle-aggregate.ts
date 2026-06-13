export interface RawCandle {
  timestamp: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  closePrice: string;
  volume: string;
}

export interface AggregatedCandle {
  timestamp: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  closePrice: string;
  volume: string;
}

const MAX_CANDLES_PER_REQUEST = 200;

function toNumber(value: string) {
  return Number(value);
}

function sortAsc(candles: RawCandle[]) {
  return candles
    .slice()
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

function parseOffsetMinutes(timestamp: string) {
  const match = timestamp.match(/([+-])(\d{2}):(\d{2})$/);
  if (!match) return 0;
  const sign = match[1] === '+' ? 1 : -1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

function formatBucketTimestamp(bucketStartMs: number, referenceTimestamp: string) {
  const offsetMinutes = parseOffsetMinutes(referenceTimestamp);
  if (offsetMinutes === 0) {
    return new Date(bucketStartMs).toISOString();
  }

  const shifted = new Date(bucketStartMs + offsetMinutes * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteHours = pad(Math.floor(Math.abs(offsetMinutes) / 60));
  const absoluteMinutes = pad(Math.abs(offsetMinutes) % 60);

  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}.000${sign}${absoluteHours}:${absoluteMinutes}`;
}

function aggregateBucket(
  candles: RawCandle[],
  bucketKey: (timestamp: string) => string,
  formatTimestamp?: (bucketKey: string, group: RawCandle[]) => string
): AggregatedCandle[] {
  const buckets = new Map<string, RawCandle[]>();

  for (const candle of sortAsc(candles)) {
    const key = bucketKey(candle.timestamp);
    const group = buckets.get(key) ?? [];
    group.push(candle);
    buckets.set(key, group);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([key, group]) => {
      const open = group[0];
      const close = group[group.length - 1];
      const high = Math.max(...group.map((c) => toNumber(c.highPrice)));
      const low = Math.min(...group.map((c) => toNumber(c.lowPrice)));
      const volume = group.reduce((sum, c) => sum + toNumber(c.volume), 0);

      return {
        timestamp: formatTimestamp ? formatTimestamp(key, group) : open.timestamp,
        openPrice: open.openPrice,
        highPrice: String(high),
        lowPrice: String(low),
        closePrice: close.closePrice,
        volume: String(volume),
      };
    });
}

export function aggregateMinuteCandles(candles: RawCandle[], minutes: 5 | 10) {
  const bucketMs = minutes * 60 * 1000;

  return aggregateBucket(
    candles,
    (timestamp) => {
      const bucketStart = Math.floor(new Date(timestamp).getTime() / bucketMs) * bucketMs;
      return String(bucketStart);
    },
    (bucketKey, group) => formatBucketTimestamp(Number(bucketKey), group[0].timestamp)
  );
}

function getWeekKey(timestamp: string) {
  const date = new Date(timestamp);
  const day = date.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() + mondayOffset);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString().slice(0, 10);
}

function getMonthKey(timestamp: string) {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function aggregateWeeklyCandles(candles: RawCandle[]) {
  return aggregateBucket(candles, getWeekKey);
}

export function aggregateMonthlyCandles(candles: RawCandle[]) {
  return aggregateBucket(candles, getMonthKey);
}

export type SupportedCandleInterval = '1m' | '5m' | '10m' | '1d' | '1w' | '1M';

export function isNativeInterval(interval: string): interval is '1m' | '1d' {
  return interval === '1m' || interval === '1d';
}

export function getSourceInterval(interval: SupportedCandleInterval): '1m' | '1d' {
  if (interval === '1w' || interval === '1M' || interval === '1d') {
    return '1d';
  }
  return '1m';
}

export function getMinuteAggregationFactor(interval: SupportedCandleInterval) {
  if (interval === '5m') return 5;
  if (interval === '10m') return 10;
  return null;
}

export function getRequiredSourceCount(interval: SupportedCandleInterval, targetCount: number) {
  const minuteFactor = getMinuteAggregationFactor(interval);
  if (minuteFactor) {
    return targetCount * minuteFactor + minuteFactor;
  }

  if (interval === '1w') {
    return targetCount * 7 + 7;
  }

  if (interval === '1M') {
    return targetCount * 31 + 31;
  }

  return Math.min(targetCount, MAX_CANDLES_PER_REQUEST);
}

export function aggregateCandles(
  candles: RawCandle[],
  interval: SupportedCandleInterval
): AggregatedCandle[] {
  switch (interval) {
    case '5m':
      return aggregateMinuteCandles(candles, 5);
    case '10m':
      return aggregateMinuteCandles(candles, 10);
    case '1w':
      return aggregateWeeklyCandles(candles);
    case '1M':
      return aggregateMonthlyCandles(candles);
    default:
      return sortAsc(candles);
  }
}

export { MAX_CANDLES_PER_REQUEST };

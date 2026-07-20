import type { ChartCandle } from '../types';
import { buildChartSignalSnapshot, type ChartSignalLevel } from './chartSignals';

// 백테스트: 과거 캔들에 차트 신호(매수/관망/매도)를 "그 시점까지의 데이터만으로" 재계산하고
// 이후 결과(목표·손절·만기)를 라벨링해 신호별 적중률/기대값을 낸다.
// look-ahead(미래참조) 방지가 핵심 — 각 시점 i 의 신호는 candles[..i] 만 사용한다.

export interface BacktestConfig {
  forwardBars: number; // K: 이후 몇 봉 동안 평가
  targetPct: number; // 목표 수익률 %(양수)
  stopPct: number; // 손절 %(양수)
  costPct: number; // 왕복 거래비용 %(스프레드/수수료 가정)
}

export type BacktestBucket = ChartSignalLevel;

export interface BucketStats {
  bucket: BacktestBucket;
  label: string;
  direction: 'long' | 'short' | 'none';
  count: number;
  winRate: number; // 0..1 (방향 기준 수익 > 0)
  avgReturnPct: number; // 방향 수익률 평균(비용 차감), %
}

export interface BacktestResult {
  totalEvaluated: number;
  fromTime?: number;
  toTime?: number;
  buckets: BucketStats[];
  // 신호를 따라 한 번에 1포지션만 진입(중복 없음)했을 때의 순차 전략 결과
  strategy: {
    trades: number;
    winRate: number;
    avgReturnPct: number;
    totalReturnPct: number; // 누적(단리 합)
    equity: number[]; // 누적 수익률 곡선(%)
  };
}

const BUCKET_LABELS: Record<ChartSignalLevel, string> = {
  strong_buy: '강매수',
  weak_buy: '약매수',
  neutral: '관망',
  weak_sell: '약매도',
  strong_sell: '강매도',
};

const SIGNAL_LOOKBACK = 60; // 지표는 최근 ≤50개만 보므로 60개 윈도우면 충분(속도↑)
const MIN_HISTORY = 50; // SMA(50) 가 채워지는 시점부터 평가 시작

function directionOf(level: ChartSignalLevel): 'long' | 'short' | 'none' {
  if (level === 'strong_buy' || level === 'weak_buy') return 'long';
  if (level === 'strong_sell' || level === 'weak_sell') return 'short';
  return 'none';
}

// i 시점(종가 진입) 이후 forwardBars 동안의 방향 수익률(비용 차감). target/stop 먼저 닿는 쪽 우선,
// 둘 다 안 닿으면 만기 종가. 한 봉 안에서 둘 다 닿으면 보수적으로 손절 우선.
function evaluateTrade(
  candles: ChartCandle[],
  i: number,
  direction: 'long' | 'short',
  config: BacktestConfig
): number {
  const entry = candles[i].close;
  if (entry <= 0) return 0;

  const t = config.targetPct / 100;
  const s = config.stopPct / 100;
  const last = Math.min(i + config.forwardBars, candles.length - 1);

  const targetPrice = direction === 'long' ? entry * (1 + t) : entry * (1 - t);
  const stopPrice = direction === 'long' ? entry * (1 - s) : entry * (1 + s);

  for (let j = i + 1; j <= last; j += 1) {
    const bar = candles[j];
    if (direction === 'long') {
      if (bar.low <= stopPrice) return -s * 100 - config.costPct;
      if (bar.high >= targetPrice) return t * 100 - config.costPct;
    } else {
      if (bar.high >= stopPrice) return -s * 100 - config.costPct;
      if (bar.low <= targetPrice) return t * 100 - config.costPct;
    }
  }

  // 만기: 종가로 청산
  const exit = candles[last].close;
  const raw = ((exit - entry) / entry) * 100;
  const directional = direction === 'long' ? raw : -raw;
  return directional - config.costPct;
}

/**
 * 시점별 신호 레벨 사전 계산(정렬된 캔들 기준, null=데이터 부족).
 * 신호는 목표/손절 설정과 무관하므로, 여러 시나리오를 돌리는 최적화에서는
 * 이 결과를 runBacktest 에 재사용해 가장 비싼 신호 계산을 1회로 줄인다.
 */
export function computeBacktestSignals(candles: ChartCandle[]): (ChartSignalLevel | null)[] {
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const levels: (ChartSignalLevel | null)[] = new Array<ChartSignalLevel | null>(
    sorted.length
  ).fill(null);
  for (let i = MIN_HISTORY; i < sorted.length; i += 1) {
    const window = sorted.slice(Math.max(0, i - SIGNAL_LOOKBACK + 1), i + 1);
    const snapshot = buildChartSignalSnapshot({ candles: window });
    if (!snapshot.insufficientData) levels[i] = snapshot.level;
  }
  return levels;
}

export function runBacktest(
  candles: ChartCandle[],
  config: BacktestConfig,
  precomputedLevels?: (ChartSignalLevel | null)[]
): BacktestResult {
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const n = sorted.length;

  const buckets: Record<ChartSignalLevel, { count: number; wins: number; sumReturn: number }> = {
    strong_buy: { count: 0, wins: 0, sumReturn: 0 },
    weak_buy: { count: 0, wins: 0, sumReturn: 0 },
    neutral: { count: 0, wins: 0, sumReturn: 0 },
    weak_sell: { count: 0, wins: 0, sumReturn: 0 },
    strong_sell: { count: 0, wins: 0, sumReturn: 0 },
  };

  const lastEvaluable = n - 1 - config.forwardBars;
  let totalEvaluated = 0;
  let fromTime: number | undefined;
  let toTime: number | undefined;

  // 순차 전략(중복 진입 없음)용 상태
  let busyUntil = -1; // 이 인덱스까지는 포지션 보유 중 → 새 진입 금지
  const tradeReturns: number[] = [];
  const equity: number[] = [];
  let cumulative = 0;

  for (let i = MIN_HISTORY; i <= lastEvaluable; i += 1) {
    let level: ChartSignalLevel | null;
    if (precomputedLevels) {
      level = precomputedLevels[i] ?? null;
    } else {
      const window = sorted.slice(Math.max(0, i - SIGNAL_LOOKBACK + 1), i + 1);
      const snapshot = buildChartSignalSnapshot({ candles: window });
      level = snapshot.insufficientData ? null : snapshot.level;
    }
    if (level === null) continue;

    const dir = directionOf(level);

    // 평가 방향: 관망은 참고용으로 롱 기준 forward 수익률
    const evalDir: 'long' | 'short' = dir === 'short' ? 'short' : 'long';
    const ret = evaluateTrade(sorted, i, evalDir, config);

    buckets[level].count += 1;
    buckets[level].sumReturn += ret;
    if (ret > 0) buckets[level].wins += 1;

    totalEvaluated += 1;
    if (fromTime === undefined) fromTime = sorted[i].time;
    toTime = sorted[i].time;

    // 순차 전략: 비관망 신호이고 현재 포지션 없을 때만 진입
    if (dir !== 'none' && i > busyUntil) {
      tradeReturns.push(ret);
      cumulative += ret;
      equity.push(cumulative);
      busyUntil = i + config.forwardBars; // 보유 기간 동안 새 진입 차단
    }
  }

  const bucketStats: BucketStats[] = (Object.keys(buckets) as ChartSignalLevel[]).map((level) => {
    const b = buckets[level];
    return {
      bucket: level,
      label: BUCKET_LABELS[level],
      direction: directionOf(level),
      count: b.count,
      winRate: b.count > 0 ? b.wins / b.count : 0,
      avgReturnPct: b.count > 0 ? b.sumReturn / b.count : 0,
    };
  });

  const wins = tradeReturns.filter((r) => r > 0).length;
  const totalReturn = tradeReturns.reduce((sum, r) => sum + r, 0);

  return {
    totalEvaluated,
    fromTime,
    toTime,
    buckets: bucketStats,
    strategy: {
      trades: tradeReturns.length,
      winRate: tradeReturns.length > 0 ? wins / tradeReturns.length : 0,
      avgReturnPct: tradeReturns.length > 0 ? totalReturn / tradeReturns.length : 0,
      totalReturnPct: totalReturn,
      equity,
    },
  };
}

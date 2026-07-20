import {
  computeBacktestSignals,
  runBacktest,
  type BacktestResult,
} from './backtest';
import type { ChartCandle } from '../types';

/**
 * 백테스트 자동 최적화 — 여러 (익절%, 손절%) 시나리오를 전수 실행해 성과를 비교한다.
 * 신호 계산은 목표/손절과 무관하므로 1회만 수행하고 전 시나리오에 재사용한다(속도 핵심).
 * "최적" 판정은 AI(서버)가 표본 수·승률·기대값·MDD·과최적화 위험까지 종합해 내린다.
 */

export const OPTIMIZE_TARGET_GRID = [0.5, 1, 1.5, 2, 3, 5];
export const OPTIMIZE_STOP_GRID = [1, 2, 3, 5];

export interface OptimizedScenario {
  targetPct: number;
  stopPct: number;
  trades: number;
  winRatePct: number;
  avgReturnPct: number;
  totalReturnPct: number;
  /** 누적 수익 곡선의 최대 낙폭(%p). */
  maxDrawdownPct: number;
  result: BacktestResult;
}

function maxDrawdown(equity: number[]): number {
  let peak = 0;
  let mdd = 0;
  for (const value of equity) {
    peak = Math.max(peak, value);
    mdd = Math.max(mdd, peak - value);
  }
  return mdd;
}

/** 그리드 전수 실행 — 누적 수익률 내림차순으로 정렬해 돌려준다(index 0 = 누적 1위). */
export function optimizeBacktestScenarios(
  candles: ChartCandle[],
  base: { forwardBars: number; costPct: number }
): OptimizedScenario[] {
  const levels = computeBacktestSignals(candles);
  const scenarios: OptimizedScenario[] = [];
  for (const targetPct of OPTIMIZE_TARGET_GRID) {
    for (const stopPct of OPTIMIZE_STOP_GRID) {
      const result = runBacktest(
        candles,
        { forwardBars: base.forwardBars, targetPct, stopPct, costPct: base.costPct },
        levels
      );
      scenarios.push({
        targetPct,
        stopPct,
        trades: result.strategy.trades,
        winRatePct: result.strategy.winRate * 100,
        avgReturnPct: result.strategy.avgReturnPct,
        totalReturnPct: result.strategy.totalReturnPct,
        maxDrawdownPct: maxDrawdown(result.strategy.equity),
        result,
      });
    }
  }
  return scenarios.sort((a, b) => b.totalReturnPct - a.totalReturnPct);
}

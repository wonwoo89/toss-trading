import { useState } from 'react';
import { BacktestResultView } from './BacktestResultView';
import {
  BACKTEST_INTERVAL_OPTIONS,
  runSymbolBacktest,
  type SymbolBacktestOutcome,
} from '../shared/lib/runSymbolBacktest';
import type { BacktestConfig } from '../shared/lib/backtest';
import type { CandleInterval } from '../shared/types';

export function BacktestPanel({ initialSymbol = 'AAPL' }: { initialSymbol?: string }) {
  const [symbol, setSymbol] = useState(initialSymbol);
  const [interval, setInterval] = useState<CandleInterval>('5m');
  const [forwardBars, setForwardBars] = useState(15);
  const [targetPct, setTargetPct] = useState(5);
  const [stopPct, setStopPct] = useState(1);
  const [costPct, setCostPct] = useState(0.05);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [outcome, setOutcome] = useState<SymbolBacktestOutcome>();

  const run = async () => {
    const sym = symbol.trim().toUpperCase();
    if (!sym) return;
    setLoading(true);
    setError(undefined);
    setOutcome(undefined);
    try {
      const config: BacktestConfig = { forwardBars, targetPct, stopPct, costPct };
      await new Promise((r) => setTimeout(r, 0));
      setOutcome(await runSymbolBacktest(sym, interval, config));
    } catch (e) {
      setError(e instanceof Error ? e.message : '백테스트 실패');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="backtest-panel">
      <section className="panel backtest-controls">
        <label>
          종목
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            placeholder="AAPL"
            onKeyDown={(e) => e.key === 'Enter' && run()}
          />
        </label>
        <label title="신호를 계산·평가할 캔들 단위(분/일)">
          캔들
          <select value={interval} onChange={(e) => setInterval(e.target.value as CandleInterval)}>
            {BACKTEST_INTERVAL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label title="신호 발생 후 결과를 평가할 봉 수. 예: K=15 → 이후 15봉 안에 목표/손절 도달 여부로 판정(미도달 시 만기 종가).">
          예측 봉수 (K)
          <input
            type="number"
            min={1}
            max={120}
            value={forwardBars}
            onChange={(e) => setForwardBars(Math.max(1, Number(e.target.value)))}
          />
        </label>
        <label title="진입 후 이 비율(+%)에 먼저 도달하면 익절로 판정.">
          목표 +%
          <input
            type="number"
            min={0.1}
            step={0.1}
            value={targetPct}
            onChange={(e) => setTargetPct(Math.max(0.1, Number(e.target.value)))}
          />
        </label>
        <label title="진입 후 이 비율(−%)에 먼저 도달하면 손절로 판정.">
          손절 −%
          <input
            type="number"
            min={0.1}
            step={0.1}
            value={stopPct}
            onChange={(e) => setStopPct(Math.max(0.1, Number(e.target.value)))}
          />
        </label>
        <label title="1회 매매(매수+매도) 왕복에 드는 거래비용(수수료+스프레드+세금) 추정치. 각 거래 수익률에서 그대로 차감합니다. 매수 비중/포지션 크기와는 무관합니다.">
          거래비용 %
          <input
            type="number"
            min={0}
            step={0.01}
            value={costPct}
            onChange={(e) => setCostPct(Math.max(0, Number(e.target.value)))}
          />
        </label>
        <button type="button" className="backtest-run" onClick={run} disabled={loading}>
          {loading ? '계산 중…' : '실행'}
        </button>
      </section>

      {error && <div className="banner error">{error}</div>}

      {outcome && (
        <BacktestResultView result={outcome.result} usedCandles={outcome.usedCandles} />
      )}
    </div>
  );
}

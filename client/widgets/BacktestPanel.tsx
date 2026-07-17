import { useState } from 'react';
import { BacktestResultView } from './BacktestResultView';
import { Typography } from '../shared/ui/Typography';
import { NumberField } from './NumberField';
import { TextField } from '../shared/ui/TextField';
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
  const [targetPct, setTargetPct] = useState(1);
  const [stopPct, setStopPct] = useState(3);
  const [costPct, setCostPct] = useState(0.2);

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
        <TextField
          label="종목"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          placeholder="AAPL"
          onKeyDown={(e) => e.key === 'Enter' && run()}
        />
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
        <NumberField
          label="예측 봉수 (K)"
          unit="봉"
          title="신호 발생 후 결과를 평가할 봉 수. 예: K=15 → 이후 15봉 안에 목표/손절 도달 여부로 판정(미도달 시 만기 종가)."
          integer
          min={1}
          max={120}
          value={forwardBars}
          onChange={setForwardBars}
        />
        <NumberField
          label="목표"
          unit="+%"
          title="진입 후 이 비율(+%)에 먼저 도달하면 익절로 판정."
          min={0.1}
          value={targetPct}
          onChange={setTargetPct}
        />
        <NumberField
          label="손절"
          unit="−%"
          title="진입 후 이 비율(−%)에 먼저 도달하면 손절로 판정."
          min={0.1}
          value={stopPct}
          onChange={setStopPct}
        />
        <NumberField
          label="거래비용"
          unit="%"
          title="1회 매매(매수+매도) 왕복에 드는 거래비용(수수료+스프레드+세금) 추정치. 각 거래 수익률에서 그대로 차감합니다. 매수 비중/포지션 크기와는 무관합니다."
          min={0}
          value={costPct}
          onChange={setCostPct}
        />
        <button type="button" className="backtest-run" onClick={run} disabled={loading}>
          {loading ? '계산 중…' : '실행'}
        </button>
      </section>

      {error && <Typography size={14} as="div" className="banner error">{error}</Typography>}

      {outcome && (
        <BacktestResultView result={outcome.result} usedCandles={outcome.usedCandles} />
      )}
    </div>
  );
}

import { useState } from 'react';
import { BacktestResultView } from './BacktestResultView';
import { Typography } from '../shared/ui/Typography';
import { Button } from '../shared/ui/Button';
import { NumberField } from './NumberField';
import { TextField } from '../shared/ui/TextField';
import {
  BACKTEST_INTERVAL_OPTIONS,
  optimizeSymbolBacktest,
  runSymbolBacktest,
  type SymbolBacktestOutcome,
} from '../shared/lib/runSymbolBacktest';
import type { BacktestConfig } from '../shared/lib/backtest';
import type { OptimizedScenario } from '../shared/lib/backtestOptimize';
import { api, type BacktestAnalysis } from '../shared/api/client';
import { applyAutoTradeSettings } from '../shared/lib/autoTradeApplyBus';
import { useToast } from '../app/providers/ToastContext';
import type { CandleInterval } from '../shared/types';

export function BacktestPanel({ initialSymbol = 'AAPL' }: { initialSymbol?: string }) {
  const { showToast } = useToast();
  const [symbol, setSymbol] = useState(initialSymbol);
  const [interval, setInterval] = useState<CandleInterval>('5m');
  const [forwardBars, setForwardBars] = useState(15);
  const [targetPct, setTargetPct] = useState(1);
  const [stopPct, setStopPct] = useState(3);
  const [costPct, setCostPct] = useState(0.2);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [outcome, setOutcome] = useState<SymbolBacktestOutcome>();

  // AI 최적화 — (익절×손절) 그리드 전수 실행 + AI 종합 추천.
  const [optimizing, setOptimizing] = useState(false);
  const [scenarios, setScenarios] = useState<OptimizedScenario[]>();
  const [analysis, setAnalysis] = useState<BacktestAnalysis>();

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

  const optimize = async () => {
    const sym = symbol.trim().toUpperCase();
    if (!sym) return;
    setOptimizing(true);
    setError(undefined);
    setScenarios(undefined);
    setAnalysis(undefined);
    try {
      await new Promise((r) => setTimeout(r, 0));
      const { scenarios: results, usedCandles } = await optimizeSymbolBacktest(sym, interval, {
        forwardBars,
        costPct,
      });
      setScenarios(results);
      // AI 종합 추천 — 실패해도 그리드 결과(누적 1위 폴백)는 그대로 보여준다.
      const res = await api.analyzeBacktestScenarios({
        symbol: sym,
        interval,
        forwardBars,
        costPct,
        usedCandles,
        scenarios: results.map((s) => ({
          targetPct: s.targetPct,
          stopPct: s.stopPct,
          trades: s.trades,
          winRatePct: s.winRatePct,
          avgReturnPct: s.avgReturnPct,
          totalReturnPct: s.totalReturnPct,
          maxDrawdownPct: s.maxDrawdownPct,
        })),
      });
      setAnalysis(res.result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'AI 최적화 실패');
    } finally {
      setOptimizing(false);
    }
  };

  // 선택 시나리오를 이 패널 설정 + AI 자동매매(목표/손절)에 적용.
  const applyScenario = (s: OptimizedScenario) => {
    setTargetPct(s.targetPct);
    setStopPct(s.stopPct);
    applyAutoTradeSettings({
      targetPercent: s.targetPct,
      stopLossPercent: s.stopPct,
      symbol: symbol.trim().toUpperCase(),
      source: '백테스트 최적화',
    });
    showToast(`AI 자동매매에 적용: 목표 +${s.targetPct}% / 손절 -${s.stopPct}%`, 'success');
  };

  const bestIndex = analysis ? Math.min(analysis.bestIndex, (scenarios?.length ?? 1) - 1) : 0;
  const best = scenarios?.[bestIndex];
  const topScenarios = scenarios?.slice(0, 5) ?? [];
  const showBestSeparately = best !== undefined && bestIndex >= 5;

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
        <button type="button" className="backtest-run" onClick={run} disabled={loading || optimizing}>
          {loading ? '계산 중…' : '실행'}
        </button>
        <button
          type="button"
          className="backtest-run backtest-run--optimize"
          onClick={optimize}
          disabled={loading || optimizing}
          title="여러 익절×손절 조합을 전수 백테스트하고 AI 가 표본·승률·기대값·MDD 를 종합해 최적 조합을 추천합니다. (목표/손절 입력값은 무시하고 그리드로 탐색)"
        >
          {optimizing ? 'AI 최적화 중…' : 'AI 최적화'}
        </button>
      </section>

      {error && <Typography size={14} as="div" className="banner error">{error}</Typography>}

      {scenarios && best && (
        <section className="panel backtest-optimize">
          <div className="backtest-optimize__head">
            <Typography size={16} as="h3">AI 최적화 결과</Typography>
            <Typography size={12} className="hint">
              익절 {'{0.5, 1, 1.5, 2, 3, 5}'} × 손절 {'{1, 2, 3, 5}'} — {scenarios.length}개 조합
            </Typography>
          </div>

          <div className="backtest-optimize__pick">
            <Typography size={14} as="p" className="backtest-optimize__pick-title">
              🤖 AI 추천: <strong>익절 +{best.targetPct}% / 손절 -{best.stopPct}%</strong>
              {' '}(거래 {best.trades}회 · 승률 {best.winRatePct.toFixed(1)}% · 누적{' '}
              {best.totalReturnPct >= 0 ? '+' : ''}
              {best.totalReturnPct.toFixed(2)}%)
            </Typography>
            {analysis?.reason && (
              <Typography size={12} as="p" className="backtest-optimize__reason">
                {analysis.reason}
              </Typography>
            )}
            {analysis?.caution && (
              <Typography size={12} as="p" className="backtest-optimize__caution">
                ⚠ {analysis.caution}
              </Typography>
            )}
            <Button size="sm" variant="accent" onClick={() => applyScenario(best)}>
              이 설정으로 AI 자동매매 적용
            </Button>
          </div>

          <div className="backtest-optimize__table-wrap">
            <table className="backtest-optimize__table">
              <thead>
                <tr>
                  <th>익절</th>
                  <th>손절</th>
                  <th>거래</th>
                  <th>승률</th>
                  <th>평균</th>
                  <th>누적</th>
                  <th>MDD</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(showBestSeparately ? [best, ...topScenarios] : topScenarios).map((s) => {
                  const isBest = s === best;
                  return (
                    <tr key={`${s.targetPct}-${s.stopPct}`} className={isBest ? 'is-best' : ''}>
                      <td>+{s.targetPct}%</td>
                      <td>-{s.stopPct}%</td>
                      <td>{s.trades}</td>
                      <td>{s.winRatePct.toFixed(1)}%</td>
                      <td>{s.avgReturnPct.toFixed(3)}%</td>
                      <td className={s.totalReturnPct >= 0 ? 'up' : 'down'}>
                        {s.totalReturnPct >= 0 ? '+' : ''}
                        {s.totalReturnPct.toFixed(2)}%
                      </td>
                      <td>{s.maxDrawdownPct.toFixed(2)}%p</td>
                      <td>
                        <Button size="sm" variant="ghost" onClick={() => applyScenario(s)}>
                          적용
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Typography size={12} as="p" className="hint backtest-optimize__note">
            '적용'은 이 패널의 목표/손절과 <strong>AI 자동매매(차트 탭)의 목표/손절</strong>을 함께
            바꿉니다. 자동매매 모드 자체는 켜지 않으니 차트 탭에서 모드를 확인하세요.
          </Typography>
        </section>
      )}

      {outcome && (
        <BacktestResultView result={outcome.result} usedCandles={outcome.usedCandles} />
      )}
    </div>
  );
}

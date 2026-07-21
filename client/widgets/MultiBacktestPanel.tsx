import { useCallback, useEffect, useState } from 'react';
import { useAppContext } from '../app/providers/AppContext';
import { useToast } from '../app/providers/ToastContext';
import { api, type BacktestAnalysis } from '../shared/api/client';
import { unwrapResult } from '../shared/lib/parse';
import { mapHoldings } from '../entities/position';
import { getCachedHoldings } from '../features/trade/useSymbolTrading';
import { BacktestResultView } from './BacktestResultView';
import { NumberField } from './NumberField';
import { Button } from '../shared/ui/Button';
import { TextField } from '../shared/ui/TextField';
import { Typography } from '../shared/ui/Typography';
import { backtestBiasClass, fmtBacktestPct } from '../shared/lib/backtestFormat';
import { applyAutoTradeSettings } from '../shared/lib/autoTradeApplyBus';
import {
  BACKTEST_INTERVAL_OPTIONS,
  runSymbolBacktestFull,
  type SymbolBacktestOutcome,
} from '../shared/lib/runSymbolBacktest';
import type { BacktestConfig } from '../shared/lib/backtest';
import type { OptimizedScenario } from '../shared/lib/backtestOptimize';
import type { CandleInterval } from '../shared/types';

type RowStatus = 'idle' | 'loading' | 'done' | 'error';

interface BacktestRow {
  id: string;
  symbol: string;
  name?: string;
  status: RowStatus;
  outcome?: SymbolBacktestOutcome;
  /** AI 종합 추천(최적 시나리오 인덱스·사유) — 실패 시 undefined(누적 1위 폴백). */
  analysis?: BacktestAnalysis;
  error?: string;
}

// 전체 실행 시 동시 실행 개수(토스 캔들 API 부담을 줄이기 위해 소수로 제한).
const RUN_CONCURRENCY = 3;

function holdingsToRows(
  holdings: { symbol: string; name?: string }[]
): BacktestRow[] {
  const seen = new Set<string>();
  const rows: BacktestRow[] = [];
  for (const h of holdings) {
    const sym = h.symbol?.toUpperCase();
    if (!sym || seen.has(sym)) continue;
    seen.add(sym);
    rows.push({ id: crypto.randomUUID(), symbol: sym, name: h.name, status: 'idle' });
  }
  return rows;
}

/** 행의 AI 추천 시나리오 — AI bestIndex(없으면 누적 1위 = 0). */
function bestScenarioOf(row: BacktestRow): OptimizedScenario | undefined {
  const scenarios = row.outcome?.scenarios;
  if (!scenarios?.length) return undefined;
  const idx = row.analysis ? Math.min(row.analysis.bestIndex, scenarios.length - 1) : 0;
  return scenarios[idx];
}

export function MultiBacktestPanel({ initialExtraSymbol }: { initialExtraSymbol?: string }) {
  const { selectedAccountSeq } = useAppContext();
  const { showToast } = useToast();

  const [interval, setIntervalValue] = useState<CandleInterval>('5m');
  const [forwardBars, setForwardBars] = useState(15);
  const [targetPct, setTargetPct] = useState(1);
  const [stopPct, setStopPct] = useState(3);
  const [costPct, setCostPct] = useState(0.2);

  const [rows, setRows] = useState<BacktestRow[]>(() => {
    const seeded = holdingsToRows(getCachedHoldings(selectedAccountSeq));
    const extra = initialExtraSymbol?.trim().toUpperCase();
    if (extra && !seeded.some((r) => r.symbol.toUpperCase() === extra)) {
      seeded.push({ id: crypto.randomUUID(), symbol: extra, status: 'idle' });
    }
    return seeded;
  });
  const [holdingsLoading, setHoldingsLoading] = useState(false);
  const [runningAll, setRunningAll] = useState(false);
  const [addSymbol, setAddSymbol] = useState('');
  const [detailId, setDetailId] = useState<string>();

  const config: BacktestConfig = { forwardBars, targetPct, stopPct, costPct };

  // 보유 종목을 기본 행으로 시드. 캐시로 즉시 채우고, 최신값을 API 로 갱신.
  useEffect(() => {
    if (!selectedAccountSeq) return;
    let cancelled = false;
    setHoldingsLoading(true);
    (async () => {
      try {
        const snap = unwrapResult(await api.getPortfolioSnapshot(selectedAccountSeq));
        if (cancelled) return;
        const holdings = mapHoldings(snap.holdings).filter((h) => h.quantity > 0);
        setRows((prev) => {
          // 사용자가 직접 추가한(보유 목록에 없는) 종목은 유지하고, 보유분으로 갱신.
          const holdingSyms = new Set(holdings.map((h) => h.symbol.toUpperCase()));
          const customRows = prev.filter((r) => !holdingSyms.has(r.symbol.toUpperCase()));
          const holdingRows = holdingsToRows(holdings).map((hr) => {
            const existing = prev.find((r) => r.symbol.toUpperCase() === hr.symbol.toUpperCase());
            return existing ? { ...existing, name: hr.name } : hr;
          });
          return [...holdingRows, ...customRows];
        });
      } catch {
        // 보유 종목 조회 실패는 무시(직접 추가로 사용 가능)
      } finally {
        if (!cancelled) setHoldingsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedAccountSeq]);

  const patchRow = useCallback((id: string, patch: Partial<BacktestRow>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }, []);

  const runRow = useCallback(
    async (id: string, symbol: string, intv: CandleInterval, cfg: BacktestConfig) => {
      patchRow(id, { status: 'loading', error: undefined, analysis: undefined });
      try {
        // 캔들 1회 조회로 설정 백테스트 + AI 최적화 그리드를 함께 계산.
        const outcome = await runSymbolBacktestFull(symbol, intv, cfg);
        patchRow(id, { status: 'done', outcome });
        // AI 종합 추천 — 실패해도 그리드 결과(누적 1위 폴백)는 그대로 보여준다.
        if (outcome.scenarios?.length) {
          try {
            const res = await api.analyzeBacktestScenarios({
              symbol,
              interval: intv,
              forwardBars: cfg.forwardBars,
              costPct: cfg.costPct,
              usedCandles: outcome.usedCandles,
              scenarios: outcome.scenarios.map((s) => ({
                targetPct: s.targetPct,
                stopPct: s.stopPct,
                trades: s.trades,
                winRatePct: s.winRatePct,
                avgReturnPct: s.avgReturnPct,
                totalReturnPct: s.totalReturnPct,
                maxDrawdownPct: s.maxDrawdownPct,
              })),
            });
            patchRow(id, { analysis: res.result });
          } catch {
            // AI 추천 실패 — 폴백(누적 1위)으로 표시
          }
        }
      } catch (e) {
        patchRow(id, {
          status: 'error',
          error: e instanceof Error ? e.message : '백테스트 실패',
          outcome: undefined,
        });
      }
    },
    [patchRow]
  );

  const runAll = async () => {
    const targets = rows.map((r) => ({ id: r.id, symbol: r.symbol }));
    if (targets.length === 0) return;
    setRunningAll(true);
    // 동시 실행 수를 제한한 간단한 풀.
    let idx = 0;
    const workers = Array.from({ length: Math.min(RUN_CONCURRENCY, targets.length) }, async () => {
      while (idx < targets.length) {
        const cur = targets[idx];
        idx += 1;
        await runRow(cur.id, cur.symbol, interval, config);
      }
    });
    await Promise.all(workers);
    setRunningAll(false);
  };

  const addRow = useCallback(() => {
    const sym = addSymbol.trim().toUpperCase();
    if (!sym) return;
    setRows((prev) => {
      if (prev.some((r) => r.symbol.toUpperCase() === sym)) return prev;
      return [...prev, { id: crypto.randomUUID(), symbol: sym, status: 'idle' }];
    });
    setAddSymbol('');
  }, [addSymbol]);

  const removeRow = useCallback((id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
    setDetailId((cur) => (cur === id ? undefined : cur));
  }, []);

  const detailRow = rows.find((r) => r.id === detailId && r.outcome);

  // 추천 시나리오를 이 패널 설정 + AI 자동매매(목표/손절)에 적용.
  const applyScenario = (symbol: string, s: OptimizedScenario) => {
    setTargetPct(s.targetPct);
    setStopPct(s.stopPct);
    applyAutoTradeSettings({
      targetPercent: s.targetPct,
      stopLossPercent: s.stopPct,
      symbol,
      source: '백테스트 최적화',
    });
    showToast(`AI 자동매매에 적용: 목표 +${s.targetPct}% / 손절 -${s.stopPct}%`, 'success');
  };

  return (
    <div className="backtest-panel multi-backtest">
      <section className="panel backtest-controls">
        <label title="신호를 계산·평가할 캔들 단위(분/일). 모든 종목에 동일 적용.">
          캔들
          <select
            value={interval}
            onChange={(e) => setIntervalValue(e.target.value as CandleInterval)}
          >
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
          title="1회 매매(매수+매도) 왕복에 드는 거래비용(수수료+스프레드+세금) 추정치. 각 거래 수익률에서 그대로 차감합니다."
          min={0}
          value={costPct}
          onChange={setCostPct}
        />
        <button
          type="button"
          className="backtest-run"
          onClick={runAll}
          disabled={runningAll || rows.length === 0}
        >
          {runningAll ? '실행 중…' : `전체 실행 (${rows.length})`}
        </button>
      </section>

      <section className="panel backtest-rows">
        <div className="backtest-rows__head">
          <Typography size={16} as="h2">종목별 결과</Typography>
          {holdingsLoading && <Typography size={14} className="hint">보유 종목 불러오는 중…</Typography>}
        </div>

        {rows.length === 0 && (
          <Typography size={14} as="p" className="hint">
            보유 종목이 없습니다. 아래에서 종목을 추가해 백테스트해 보세요.
          </Typography>
        )}

        <ul className="backtest-row-list">
          {rows.map((row) => (
            <li key={row.id} className="backtest-row">
              <div className="backtest-row__head">
                <div className="backtest-row__symbol">
                  <Typography size={16} as="strong">{row.symbol}</Typography>
                  {row.name && (
                    <Typography size={12} truncate className="backtest-row__name">
                      {row.name}
                    </Typography>
                  )}
                </div>
                <div className="backtest-row__actions">
                  <button
                    type="button"
                    className="backtest-row__btn"
                    onClick={() => runRow(row.id, row.symbol, interval, config)}
                    disabled={row.status === 'loading' || runningAll}
                  >
                    {row.status === 'loading' ? '계산 중…' : '실행'}
                  </button>
                  <button
                    type="button"
                    className="backtest-row__btn"
                    onClick={() => setDetailId(row.id)}
                    disabled={row.status !== 'done'}
                  >
                    상세
                  </button>
                  <button
                    type="button"
                    className="backtest-row__btn backtest-row__btn--remove"
                    onClick={() => removeRow(row.id)}
                    aria-label={`${row.symbol} 제거`}
                  >
                    ✕
                  </button>
                </div>
              </div>

              {row.status === 'error' && (
                <Typography size={12} as="div" className="backtest-row__error">
                  {row.error}
                </Typography>
              )}

              {row.status === 'done' && row.outcome && (
                <div className="backtest-row__stats">
                  <Typography size={14}>
                    거래수{' '}
                    <Typography size={14} as="b">
                      {row.outcome.result.strategy.trades.toLocaleString()}
                    </Typography>
                  </Typography>
                  <Typography size={14}>
                    승률{' '}
                    <Typography size={14} as="b">
                      {fmtBacktestPct(row.outcome.result.strategy.winRate * 100)}
                    </Typography>
                  </Typography>
                  <Typography size={14}>
                    기대값{' '}
                    <Typography
                      size={14}
                      as="b"
                      className={backtestBiasClass(row.outcome.result.strategy.avgReturnPct)}
                    >
                      {fmtBacktestPct(row.outcome.result.strategy.avgReturnPct, true)}
                    </Typography>
                  </Typography>
                  <Typography size={14}>
                    누적{' '}
                    <Typography
                      size={14}
                      as="b"
                      className={backtestBiasClass(row.outcome.result.strategy.totalReturnPct)}
                    >
                      {fmtBacktestPct(row.outcome.result.strategy.totalReturnPct, true)}
                    </Typography>
                  </Typography>
                </div>
              )}

              {/* AI 최적화 추천 — 그리드 24조합 중 AI(bestIndex) 또는 누적 1위 폴백 */}
              {row.status === 'done' && (() => {
                const best = bestScenarioOf(row);
                if (!best) return null;
                return (
                  <div className="backtest-row__optimize">
                    <Typography size={12} as="p" className="backtest-row__optimize-pick">
                      🤖 {row.analysis ? 'AI 추천' : '누적 1위'}: 익절 +{best.targetPct}% / 손절 -
                      {best.stopPct}%{' '}
                      <Typography size={12} className={backtestBiasClass(best.totalReturnPct)}>
                        (누적 {best.totalReturnPct >= 0 ? '+' : ''}
                        {best.totalReturnPct.toFixed(2)}% · 승률 {best.winRatePct.toFixed(1)}%)
                      </Typography>
                    </Typography>
                    <Button size="sm" variant="ghost" onClick={() => applyScenario(row.symbol, best)}>
                      적용
                    </Button>
                  </div>
                );
              })()}
            </li>
          ))}
        </ul>

        <div className="backtest-add-row">
          <TextField
            value={addSymbol}
            onChange={(e) => setAddSymbol(e.target.value)}
            placeholder="종목 추가 (예: TSLA)"
            onKeyDown={(e) => e.key === 'Enter' && addRow()}
          />
          <button type="button" className="backtest-add-row__btn" onClick={addRow}>
            + 추가
          </button>
        </div>
      </section>

      {detailRow?.outcome && (
        <div
          className="backtest-modal__overlay"
          onClick={() => setDetailId(undefined)}
          role="presentation"
        >
          <div
            className="backtest-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={`${detailRow.symbol} 백테스트 상세`}
          >
            <div className="backtest-modal__head">
              <Typography size={16} as="h2" className="backtest-modal__title">
                백테스트 · {detailRow.symbol}
                {detailRow.name ? ` (${detailRow.name})` : ''}
              </Typography>
              <button
                type="button"
                className="backtest-modal__close"
                onClick={() => setDetailId(undefined)}
                aria-label="닫기"
              >
                ✕
              </button>
            </div>
            <div className="backtest-modal__body">
              {/* AI 최적화 상위 5 시나리오 — 행별 적용 가능 */}
              {detailRow.outcome.scenarios && detailRow.outcome.scenarios.length > 0 && (() => {
                const best = bestScenarioOf(detailRow);
                const top = detailRow.outcome!.scenarios!.slice(0, 5);
                const showBestSeparately = best !== undefined && !top.includes(best);
                return (
                  <section className="backtest-optimize backtest-optimize--in-modal">
                    <Typography size={14} as="h3">AI 최적화 (상위 5)</Typography>
                    {detailRow.analysis?.reason && (
                      <Typography size={12} as="p" className="backtest-optimize__reason">
                        {detailRow.analysis.reason}
                      </Typography>
                    )}
                    {detailRow.analysis?.caution && (
                      <Typography size={12} as="p" className="backtest-optimize__caution">
                        ⚠ {detailRow.analysis.caution}
                      </Typography>
                    )}
                    <div className="backtest-optimize__table-wrap">
                      <table className="backtest-optimize__table">
                        <thead>
                          <tr>
                            <th>익절</th>
                            <th>손절</th>
                            <th>거래</th>
                            <th>승률</th>
                            <th>누적</th>
                            <th>MDD</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {(showBestSeparately && best ? [best, ...top] : top).map((s) => (
                            <tr
                              key={`${s.targetPct}-${s.stopPct}`}
                              className={s === best ? 'is-best' : ''}
                            >
                              <td>+{s.targetPct}%</td>
                              <td>-{s.stopPct}%</td>
                              <td>{s.trades}</td>
                              <td>{s.winRatePct.toFixed(1)}%</td>
                              <td className={s.totalReturnPct >= 0 ? 'up' : 'down'}>
                                {s.totalReturnPct >= 0 ? '+' : ''}
                                {s.totalReturnPct.toFixed(2)}%
                              </td>
                              <td>{s.maxDrawdownPct.toFixed(2)}%p</td>
                              <td>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => applyScenario(detailRow.symbol, s)}
                                >
                                  적용
                                </Button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                );
              })()}
              <BacktestResultView
                result={detailRow.outcome.result}
                usedCandles={detailRow.outcome.usedCandles}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

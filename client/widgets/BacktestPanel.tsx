import { useState } from 'react';
import { api } from '../shared/api/client';
import { mapApiCandles } from '../shared/lib/candles';
import { unwrapResult } from '../shared/lib/parse';
import { runBacktest, type BacktestConfig, type BacktestResult } from '../shared/lib/backtest';
import type { CandleInterval, ChartCandle } from '../shared/types';

const INTERVAL_OPTIONS: { value: CandleInterval; label: string; fetch: number }[] = [
  { value: '1m', label: '1분', fetch: 1500 },
  { value: '5m', label: '5분', fetch: 1200 },
  { value: '10m', label: '10분', fetch: 1000 },
  { value: '1d', label: '일', fetch: 600 },
];

async function fetchHistory(
  symbol: string,
  interval: CandleInterval,
  targetCount: number
): Promise<ChartCandle[]> {
  const byTime = new Map<number, ChartCandle>();
  let before: string | undefined;
  for (let page = 0; page < 12 && byTime.size < targetCount; page += 1) {
    const result = unwrapResult(await api.getCandles(symbol, interval, 200, before));
    for (const candle of mapApiCandles(result.candles)) {
      byTime.set(candle.time, candle);
    }
    if (!result.nextBefore) break;
    before = result.nextBefore;
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function fmtPct(value: number, signed = false) {
  const sign = signed && value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function biasClass(value: number) {
  if (value > 0.0001) return 'backtest-pos';
  if (value < -0.0001) return 'backtest-neg';
  return '';
}

function EquitySparkline({ equity }: { equity: number[] }) {
  if (equity.length < 2) return <span className="hint">표본 부족</span>;
  const w = 480;
  const h = 120;
  const min = Math.min(0, ...equity);
  const max = Math.max(0, ...equity);
  const range = max - min || 1;
  const x = (i: number) => (i / (equity.length - 1)) * w;
  const y = (v: number) => h - ((v - min) / range) * h;
  const points = equity.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const zeroY = y(0);
  const last = equity[equity.length - 1];
  return (
    <svg className="backtest-equity" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <title>
        누적 수익률(%) 곡선. 우상향이면 꾸준히 벌었다는 뜻, 들쭉날쭉·우하향이면 운이거나 손실
        구간입니다. 점선은 0% 기준선.
      </title>
      <line x1="0" y1={zeroY} x2={w} y2={zeroY} className="backtest-equity__zero" />
      <polyline
        points={points}
        className={last >= 0 ? 'backtest-equity__line pos' : 'backtest-equity__line neg'}
      />
    </svg>
  );
}

export function BacktestPanel({ initialSymbol = 'AAPL' }: { initialSymbol?: string }) {
  const [symbol, setSymbol] = useState(initialSymbol);
  const [interval, setInterval] = useState<CandleInterval>('5m');
  const [forwardBars, setForwardBars] = useState(15);
  const [targetPct, setTargetPct] = useState(5);
  const [stopPct, setStopPct] = useState(1);
  const [costPct, setCostPct] = useState(0.05);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<BacktestResult>();
  const [usedCandles, setUsedCandles] = useState(0);

  const run = async () => {
    const sym = symbol.trim().toUpperCase();
    if (!sym) return;
    setLoading(true);
    setError(undefined);
    setResult(undefined);
    try {
      const target = INTERVAL_OPTIONS.find((o) => o.value === interval)?.fetch ?? 1000;
      const candles = await fetchHistory(sym, interval, target);
      setUsedCandles(candles.length);
      if (candles.length < 80) {
        setError('캔들 데이터가 부족합니다(최소 ~80개 필요).');
        return;
      }
      const config: BacktestConfig = { forwardBars, targetPct, stopPct, costPct };
      await new Promise((r) => setTimeout(r, 0));
      setResult(runBacktest(candles, config));
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
            {INTERVAL_OPTIONS.map((o) => (
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

      {result && (
        <>
          <section className="panel backtest-summary">
            <div
              className="backtest-summary__meta"
              title="표본 = 모든 신호 시점에서 결과를 채점한 총 횟수(관망 포함). 아래 '전략 거래수'는 그중 실제로 진입했을 매매 횟수입니다."
            >
              표본 {result.totalEvaluated.toLocaleString()}회 · 캔들 {usedCandles.toLocaleString()}개
            </div>
            <div className="backtest-strategy">
              <div
                className="backtest-stat"
                title="신호를 따라 실제 체결됐을 매매 횟수. 한 번에 1포지션만 잡고 보유 중에는 새로 진입하지 않습니다. 표본이 적으면(수십 회 미만) 통계 신뢰도가 낮습니다."
              >
                <span className="backtest-stat__label">전략 거래수</span>
                <strong>{result.strategy.trades.toLocaleString()}</strong>
              </div>
              <div
                className="backtest-stat"
                title="수익으로 끝난 거래 비율. 목표(+%)가 손절(−%)보다 크면 승률이 50% 미만이어도 이득일 수 있습니다."
              >
                <span className="backtest-stat__label">승률</span>
                <strong>{fmtPct(result.strategy.winRate * 100)}</strong>
              </div>
              <div
                className="backtest-stat"
                title="거래 1회당 평균 손익(%). 가장 중요한 지표 — 양수여야 거래비용을 이긴 엣지가 있다는 뜻입니다."
              >
                <span className="backtest-stat__label">건당 기대값</span>
                <strong className={biasClass(result.strategy.avgReturnPct)}>
                  {fmtPct(result.strategy.avgReturnPct, true)}
                </strong>
              </div>
              <div
                className="backtest-stat"
                title="모든 거래 수익률을 단순 합산(단리)한 값. 복리·금액 개념은 없고 매 거래를 같은 크기로 가정합니다."
              >
                <span className="backtest-stat__label">누적</span>
                <strong className={biasClass(result.strategy.totalReturnPct)}>
                  {fmtPct(result.strategy.totalReturnPct, true)}
                </strong>
              </div>
            </div>
            <EquitySparkline equity={result.strategy.equity} />
            <p className="hint backtest-note">
              전략: 비관망 신호 시 방향대로 진입(한 번에 1포지션, 중복 없음), 목표/손절/만기로 청산.
            </p>
          </section>

          <section className="panel backtest-table-wrap">
            <table className="backtest-table">
              <thead>
                <tr>
                  <th title="그 시점 차트 신호 등급(강매수~강매도).">신호</th>
                  <th title="매수 계열은 롱(상승 기대), 매도 계열은 숏(하락 기대)으로 평가합니다.">
                    방향
                  </th>
                  <th title="그 신호가 과거에 발생한 횟수.">표본</th>
                  <th title="그 신호를 방향대로 따랐을 때 수익으로 끝난 비율.">승률</th>
                  <th title="그 신호 거래들의 평균 손익(%, 거래비용 차감). 강매수>약매수>관망>약매도>강매도 순으로 줄어들면 신호에 변별력이 있다는 뜻입니다.">
                    평균 수익(비용 차감)
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.buckets.map((b) => (
                  <tr key={b.bucket}>
                    <td>{b.label}</td>
                    <td>
                      {b.direction === 'long' ? '매수' : b.direction === 'short' ? '매도' : '—'}
                    </td>
                    <td>{b.count.toLocaleString()}</td>
                    <td>{b.count > 0 ? fmtPct(b.winRate * 100) : '—'}</td>
                    <td className={biasClass(b.avgReturnPct)}>
                      {b.count > 0 ? fmtPct(b.avgReturnPct, true) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint backtest-note">
              ⚠️ 1분봉 등 연속 신호는 서로 겹쳐(자기상관) 표본이 독립적이지 않습니다. 비용·슬리피지·
              look-ahead를 고려해도 단순 신호의 엣지는 작은 게 정상입니다.
            </p>
          </section>
        </>
      )}
    </div>
  );
}

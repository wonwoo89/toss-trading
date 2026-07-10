import type { BacktestResult } from '../shared/lib/backtest';
import { backtestBiasClass, fmtBacktestPct } from '../shared/lib/backtestFormat';
import { Typography } from '../shared/ui/Typography';

function EquitySparkline({ equity }: { equity: number[] }) {
  if (equity.length < 2) return <Typography size={14} className="hint">표본 부족</Typography>;
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

/** 백테스트 전체 결과(요약 + 누적 곡선 + 신호별 표). 단일 패널/상세 모달이 공유한다. */
export function BacktestResultView({
  result,
  usedCandles,
}: {
  result: BacktestResult;
  usedCandles: number;
}) {
  return (
    <>
      <section className="panel backtest-summary">
        <Typography
          size={12}
          as="div"
          className="backtest-summary__meta"
          title="표본 = 모든 신호 시점에서 결과를 채점한 총 횟수(관망 포함). 아래 '전략 거래수'는 그중 실제로 진입했을 매매 횟수입니다."
        >
          표본 {result.totalEvaluated.toLocaleString()}회 · 캔들 {usedCandles.toLocaleString()}개
        </Typography>
        <div className="backtest-strategy">
          <div
            className="backtest-stat"
            title="신호를 따라 실제 체결됐을 매매 횟수. 한 번에 1포지션만 잡고 보유 중에는 새로 진입하지 않습니다. 표본이 적으면(수십 회 미만) 통계 신뢰도가 낮습니다."
          >
            <Typography size={10} className="backtest-stat__label">전략 거래수</Typography>
            <Typography size={16} as="strong">{result.strategy.trades.toLocaleString()}</Typography>
          </div>
          <div
            className="backtest-stat"
            title="수익으로 끝난 거래 비율. 목표(+%)가 손절(−%)보다 크면 승률이 50% 미만이어도 이득일 수 있습니다."
          >
            <Typography size={10} className="backtest-stat__label">승률</Typography>
            <Typography size={16} as="strong">{fmtBacktestPct(result.strategy.winRate * 100)}</Typography>
          </div>
          <div
            className="backtest-stat"
            title="거래 1회당 평균 손익(%). 가장 중요한 지표 — 양수여야 거래비용을 이긴 엣지가 있다는 뜻입니다."
          >
            <Typography size={10} className="backtest-stat__label">건당 기대값</Typography>
            <Typography size={16} as="strong" className={backtestBiasClass(result.strategy.avgReturnPct)}>
              {fmtBacktestPct(result.strategy.avgReturnPct, true)}
            </Typography>
          </div>
          <div
            className="backtest-stat"
            title="모든 거래 수익률을 단순 합산(단리)한 값. 복리·금액 개념은 없고 매 거래를 같은 크기로 가정합니다."
          >
            <Typography size={10} className="backtest-stat__label">누적</Typography>
            <Typography size={16} as="strong" className={backtestBiasClass(result.strategy.totalReturnPct)}>
              {fmtBacktestPct(result.strategy.totalReturnPct, true)}
            </Typography>
          </div>
        </div>
        <EquitySparkline equity={result.strategy.equity} />
        <Typography size={10} as="p" className="hint backtest-note">
          전략: 비관망 신호 시 방향대로 진입(한 번에 1포지션, 중복 없음), 목표/손절/만기로 청산.
        </Typography>
      </section>

      <section className="panel backtest-table-wrap">
        <table className="backtest-table">
          <thead>
            <tr>
              <Typography size={12} as="th" title="그 시점 차트 신호 등급(강매수~강매도).">신호</Typography>
              <Typography size={12} as="th" title="매수 계열은 롱(상승 기대), 매도 계열은 숏(하락 기대)으로 평가합니다.">
                방향
              </Typography>
              <Typography size={12} as="th" title="그 신호가 과거에 발생한 횟수.">표본</Typography>
              <Typography size={12} as="th" title="그 신호를 방향대로 따랐을 때 수익으로 끝난 비율.">승률</Typography>
              <Typography size={12} as="th" title="그 신호 거래들의 평균 손익(%, 거래비용 차감). 강매수>약매수>관망>약매도>강매도 순으로 줄어들면 신호에 변별력이 있다는 뜻입니다.">
                평균 수익(비용 차감)
              </Typography>
            </tr>
          </thead>
          <tbody>
            {result.buckets.map((b) => (
              <tr key={b.bucket}>
                <Typography size={14} as="td">{b.label}</Typography>
                <Typography size={14} as="td">
                  {b.direction === 'long' ? '매수' : b.direction === 'short' ? '매도' : '—'}
                </Typography>
                <Typography size={14} as="td">{b.count.toLocaleString()}</Typography>
                <Typography size={14} as="td">{b.count > 0 ? fmtBacktestPct(b.winRate * 100) : '—'}</Typography>
                <Typography size={14} as="td" className={backtestBiasClass(b.avgReturnPct)}>
                  {b.count > 0 ? fmtBacktestPct(b.avgReturnPct, true) : '—'}
                </Typography>
              </tr>
            ))}
          </tbody>
        </table>
        <Typography size={10} as="p" className="hint backtest-note">
          ⚠️ 1분봉 등 연속 신호는 서로 겹쳐(자기상관) 표본이 독립적이지 않습니다. 비용·슬리피지·
          look-ahead를 고려해도 단순 신호의 엣지는 작은 게 정상입니다.
        </Typography>
      </section>
    </>
  );
}

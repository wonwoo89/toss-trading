import { useMemo } from 'react';
import type { ChartCandle } from '../shared/types';

interface MiniChartProps {
  candles: ChartCandle[];
  averagePrice?: number;
  previousClose?: number;
  currentPrice?: number;
}

const MAX_POINTS = 60;
const W = 100;
const H = 36;

/**
 * 주문폼용 초경량 미니차트(순수 SVG 스파크라인).
 * 모바일에서 주문 시트가 본 차트를 가릴 때도 가격 흐름을 계속 볼 수 있게 한다.
 *  - 최근 완성봉 종가 라인 + 영역(상승=빨강/하락=파랑, KR 관례. 기준: 전일종가)
 *  - 마지막 점은 현재가로 치환(형성 중 봉 반영)
 *  - 평단선(점선)은 종가 범위 안에 있을 때만 표시(멀면 스케일이 뭉개져 생략)
 */
export function MiniChart({ candles, averagePrice, previousClose, currentPrice }: MiniChartProps) {
  const model = useMemo(() => {
    if (!candles || candles.length < 2) return null;

    const sorted = candles
      .slice()
      .sort((a, b) => a.time - b.time)
      .slice(-MAX_POINTS);
    const closes = sorted.map((c) => c.close);
    if (currentPrice !== undefined && currentPrice > 0) {
      closes[closes.length - 1] = currentPrice;
    }

    let min = Math.min(...closes);
    let max = Math.max(...closes);
    if (max === min) max = min + Math.max(min * 0.001, 1e-6);
    const pad = (max - min) * 0.1;
    min -= pad;
    max += pad;

    const x = (i: number) => (i / (closes.length - 1)) * W;
    const y = (v: number) => H - ((v - min) / (max - min)) * H;

    const line = closes.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
    const area = `${line} ${W},${H} 0,${H}`;

    const last = closes[closes.length - 1];
    const ref = previousClose !== undefined && previousClose > 0 ? previousClose : closes[0];
    const up = last >= ref;

    const avgY =
      averagePrice !== undefined && averagePrice >= min && averagePrice <= max
        ? y(averagePrice)
        : undefined;

    return { line, area, up, avgY };
  }, [candles, averagePrice, previousClose, currentPrice]);

  if (!model) return null;

  return (
    <div className={`mini-chart ${model.up ? 'is-up' : 'is-down'}`} aria-hidden="true">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <polygon className="mini-chart__area" points={model.area} />
        <polyline
          className="mini-chart__line"
          points={model.line}
          vectorEffect="non-scaling-stroke"
        />
        {model.avgY !== undefined && (
          <line
            className="mini-chart__avg"
            x1={0}
            x2={W}
            y1={model.avgY}
            y2={model.avgY}
            vectorEffect="non-scaling-stroke"
            strokeDasharray="3 3"
          />
        )}
      </svg>
    </div>
  );
}

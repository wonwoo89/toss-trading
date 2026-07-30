import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';

/** 펜슬 드로잉 한 획 — 시간·가격에 앵커링돼 팬/줌을 따라간다.
    time 은 차트 표시 시간(KST 시프트 적용값) 기준. */
export interface DrawingStroke {
  kind: 'free' | 'hline';
  /** hline 기준가(free 는 첫 점 가격 보관용). */
  price: number;
  /** free 전용 경로 점들. */
  points: { time: number; price: number }[];
}

type DrawTarget = Parameters<IPrimitivePaneRenderer['draw']>[0];

class DrawingRenderer implements IPrimitivePaneRenderer {
  private strokes: DrawingStroke[];
  private active: DrawingStroke | null;
  private chart: IChartApi;
  private series: ISeriesApi<SeriesType>;
  private color: string;

  constructor(
    strokes: DrawingStroke[],
    active: DrawingStroke | null,
    chart: IChartApi,
    series: ISeriesApi<SeriesType>,
    color: string
  ) {
    this.strokes = strokes;
    this.active = active;
    this.chart = chart;
    this.series = series;
    this.color = color;
  }

  draw(target: DrawTarget) {
    target.useBitmapCoordinateSpace(
      ({ context, bitmapSize, horizontalPixelRatio, verticalPixelRatio }) => {
        context.save();
        context.strokeStyle = this.color;
        context.lineWidth = Math.max(1.5, 1.5 * horizontalPixelRatio);
        context.lineJoin = 'round';
        context.lineCap = 'round';

        const drawStroke = (s: DrawingStroke) => {
          if (s.kind === 'hline') {
            const y = this.series.priceToCoordinate(s.price);
            if (y === null) return;
            context.beginPath();
            context.moveTo(0, y * verticalPixelRatio);
            context.lineTo(bitmapSize.width, y * verticalPixelRatio);
            context.stroke();
            return;
          }
          let started = false;
          context.beginPath();
          for (const pt of s.points) {
            const x = this.chart.timeScale().timeToCoordinate(pt.time as Time);
            const y = this.series.priceToCoordinate(pt.price);
            if (x === null || y === null) {
              started = false;
              continue;
            }
            const bx = x * horizontalPixelRatio;
            const by = y * verticalPixelRatio;
            if (!started) {
              context.moveTo(bx, by);
              started = true;
            } else {
              context.lineTo(bx, by);
            }
          }
          context.stroke();
        };

        for (const s of this.strokes) drawStroke(s);
        if (this.active) drawStroke(this.active);
        context.restore();
      }
    );
  }
}

class DrawingPaneView implements IPrimitivePaneView {
  private primitive: ChartDrawingPrimitive;

  constructor(primitive: ChartDrawingPrimitive) {
    this.primitive = primitive;
  }

  zOrder() {
    return 'top' as const; // 캔들 위에 그린다
  }

  renderer() {
    return this.primitive.createRenderer();
  }
}

/**
 * 펜슬 드로잉 프리미티브 — 저장된 획들과 그리는 중인 획(active)을 캔들 pane 에 렌더.
 * 좌표는 렌더 시점에 시간/가격 → 픽셀로 변환되므로 팬/줌/스케일 변경을 자동 추적한다.
 */
export class ChartDrawingPrimitive implements ISeriesPrimitive {
  private strokes: DrawingStroke[] = [];
  private active: DrawingStroke | null = null;
  private color = '#3182f6';
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly paneView = new DrawingPaneView(this);

  paneViews() {
    return [this.paneView];
  }

  attached(param: SeriesAttachedParameter) {
    this.chart = param.chart;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached() {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  setStrokes(strokes: DrawingStroke[]) {
    this.strokes = strokes;
    this.requestUpdate?.();
  }

  setActiveStroke(active: DrawingStroke | null) {
    this.active = active;
    this.requestUpdate?.();
  }

  setColor(color: string) {
    this.color = color;
    this.requestUpdate?.();
  }

  createRenderer(): IPrimitivePaneRenderer | null {
    if (!this.chart || !this.series || (this.strokes.length === 0 && !this.active)) return null;
    return new DrawingRenderer(this.strokes, this.active, this.chart, this.series, this.color);
  }
}

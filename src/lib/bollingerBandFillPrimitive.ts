import type {
  CanvasRenderingTarget2D,
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  UTCTimestamp,
} from 'lightweight-charts'
import type { BollingerBandPoint } from './bollingerBands'

class BollingerBandFillRenderer implements IPrimitivePaneRenderer {
  constructor(
    private bands: BollingerBandPoint[],
    private series: ISeriesApi<'Line'>,
    private chart: IChartApi,
    private fillColor: string,
  ) {}

  draw(target: CanvasRenderingTarget2D) {
    target.useBitmapCoordinateSpace(
      ({ context, horizontalPixelRatio, verticalPixelRatio }) => {
        const timeScale = this.chart.timeScale()
        const coordinates: { x: number; yUpper: number; yLower: number }[] = []

        for (const band of this.bands) {
          const x = timeScale.timeToCoordinate(band.time as UTCTimestamp)
          const yUpper = this.series.priceToCoordinate(band.upper)
          const yLower = this.series.priceToCoordinate(band.lower)
          if (x === null || yUpper === null || yLower === null) continue

          coordinates.push({
            x: Math.round(x * horizontalPixelRatio),
            yUpper: Math.round(yUpper * verticalPixelRatio),
            yLower: Math.round(yLower * verticalPixelRatio),
          })
        }

        if (coordinates.length < 2) return

        context.beginPath()
        context.moveTo(coordinates[0].x, coordinates[0].yUpper)
        for (let index = 1; index < coordinates.length; index += 1) {
          context.lineTo(coordinates[index].x, coordinates[index].yUpper)
        }
        for (let index = coordinates.length - 1; index >= 0; index -= 1) {
          context.lineTo(coordinates[index].x, coordinates[index].yLower)
        }
        context.closePath()
        context.fillStyle = this.fillColor
        context.fill()
      },
    )
  }
}

class BollingerBandFillPaneView implements IPrimitivePaneView {
  constructor(private primitive: BollingerBandFillPrimitive) {}

  zOrder() {
    return 'bottom' as const
  }

  renderer() {
    return this.primitive.createRenderer()
  }
}

export class BollingerBandFillPrimitive implements ISeriesPrimitive {
  private bands: BollingerBandPoint[] = []
  private fillColor = 'rgba(245, 213, 71, 0.08)'
  private chart: IChartApi | null = null
  private series: ISeriesApi<'Line'> | null = null
  private requestUpdate: (() => void) | null = null
  private readonly paneView = new BollingerBandFillPaneView(this)

  paneViews() {
    return [this.paneView]
  }

  attached(param: SeriesAttachedParameter) {
    this.chart = param.chart
    this.series = param.series as ISeriesApi<'Line'>
    this.requestUpdate = param.requestUpdate
  }

  detached() {
    this.chart = null
    this.series = null
    this.requestUpdate = null
  }

  setBands(bands: BollingerBandPoint[]) {
    this.bands = bands
    this.requestUpdate?.()
  }

  setFillColor(color: string) {
    this.fillColor = color
    this.requestUpdate?.()
  }

  createRenderer(): IPrimitivePaneRenderer | null {
    if (!this.chart || !this.series || this.bands.length < 2) return null
    return new BollingerBandFillRenderer(
      this.bands,
      this.series,
      this.chart,
      this.fillColor,
    )
  }
}
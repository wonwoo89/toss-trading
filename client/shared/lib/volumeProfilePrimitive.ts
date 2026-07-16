import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
} from 'lightweight-charts';
import type { VolumeProfile } from './volumeProfile';

type DrawTarget = Parameters<IPrimitivePaneRenderer['draw']>[0];

/** 매물대 바가 차지할 수 있는 최대 폭(캔들 pane 폭 대비). */
const MAX_WIDTH_RATIO = 0.28;
const BAR_ALPHA = 0.3;

class VolumeProfileRenderer implements IPrimitivePaneRenderer {
  private profile: VolumeProfile;
  private series: ISeriesApi<SeriesType>;
  private upColor: string;
  private downColor: string;

  constructor(
    profile: VolumeProfile,
    series: ISeriesApi<SeriesType>,
    upColor: string,
    downColor: string
  ) {
    this.profile = profile;
    this.series = series;
    this.upColor = upColor;
    this.downColor = downColor;
  }

  draw(target: DrawTarget) {
    target.useBitmapCoordinateSpace(({ context, bitmapSize, verticalPixelRatio }) => {
      const maxBarWidth = bitmapSize.width * MAX_WIDTH_RATIO;
      const gap = Math.max(1, Math.round(verticalPixelRatio)); // 바 사이 1px 간격

      context.save();
      context.globalAlpha = BAR_ALPHA;

      for (const bin of this.profile.bins) {
        const total = bin.upVolume + bin.downVolume;
        if (total <= 0) continue;
        const yTopRaw = this.series.priceToCoordinate(bin.priceHigh);
        const yBotRaw = this.series.priceToCoordinate(bin.priceLow);
        if (yTopRaw === null || yBotRaw === null) continue;

        const yTop = Math.min(yTopRaw, yBotRaw) * verticalPixelRatio;
        const yBot = Math.max(yTopRaw, yBotRaw) * verticalPixelRatio;
        const height = Math.max(1, yBot - yTop - gap);

        const width = (total / this.profile.maxTotal) * maxBarWidth;
        const upWidth = width * (bin.upVolume / total);

        // 좌측 끝에서 시작 — [양봉(빨강)][음봉(파랑)] 스택
        if (upWidth > 0) {
          context.fillStyle = this.upColor;
          context.fillRect(0, yTop, upWidth, height);
        }
        if (width - upWidth > 0) {
          context.fillStyle = this.downColor;
          context.fillRect(upWidth, yTop, width - upWidth, height);
        }
      }

      context.restore();
    });
  }
}

class VolumeProfilePaneView implements IPrimitivePaneView {
  private primitive: VolumeProfilePrimitive;

  constructor(primitive: VolumeProfilePrimitive) {
    this.primitive = primitive;
  }

  zOrder() {
    return 'bottom' as const; // 캔들 아래(배경 쪽)에 그린다
  }

  renderer() {
    return this.primitive.createRenderer();
  }
}

/**
 * 매물대(볼륨 프로파일) 프리미티브 — 캔들 pane 좌측에 가격대별 누적 거래량 가로 바.
 * 가격 좌표는 렌더 시점에 변환되므로 팬/줌/스케일 변경을 자동 추적한다.
 */
export class VolumeProfilePrimitive implements ISeriesPrimitive {
  private profile: VolumeProfile | null = null;
  private upColor = '#f04452';
  private downColor = '#3182f6';
  private visible = true;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly paneView = new VolumeProfilePaneView(this);

  paneViews() {
    return [this.paneView];
  }

  attached(param: SeriesAttachedParameter) {
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached() {
    this.series = null;
    this.requestUpdate = null;
  }

  setProfile(profile: VolumeProfile | null) {
    this.profile = profile;
    this.requestUpdate?.();
  }

  setColors(upColor: string, downColor: string) {
    this.upColor = upColor;
    this.downColor = downColor;
    this.requestUpdate?.();
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    this.requestUpdate?.();
  }

  createRenderer(): IPrimitivePaneRenderer | null {
    if (!this.visible || !this.series || !this.profile || this.profile.bins.length === 0) {
      return null;
    }
    return new VolumeProfileRenderer(this.profile, this.series, this.upColor, this.downColor);
  }
}

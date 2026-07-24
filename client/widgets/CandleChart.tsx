import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
  LineStyle,
  TickMarkType,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LogicalRange,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { calculateBollingerBandSeries } from '../shared/lib/bollingerBands';
import { calculateSupertrendSeries } from '../shared/lib/supertrend';
import { BollingerBandFillPrimitive } from '../shared/lib/bollingerBandFillPrimitive';
import { VolumeProfilePrimitive } from '../shared/lib/volumeProfilePrimitive';
import { buildVolumeProfile } from '../shared/lib/volumeProfile';
import { useTheme } from '../app/providers/ThemeContext';
import {
  getStoredChartViewport,
  setStoredChartViewport,
  type ChartViewport,
} from '../shared/lib/chartViewportPreference';
import { getChartThemeColors } from '../shared/lib/chartTheme';
import { usdMaxFractionDigits } from '../shared/lib/formatHoldings';
import { Typography } from '../shared/ui/Typography';
import type { ChartCandle } from '../shared/types';

interface CandleChartProps {
  candles: ChartCandle[];
  averagePrice?: number;
  loading?: boolean;
  error?: string | null;
  fitKey?: string;
  /** 캔들 간격('1m'|'5m'|'10m'|'1d'...) — 15분 이하 분봉일 때만 봉 마감 카운트다운 표시. */
  candleInterval?: string;
  hasMoreHistory?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  showBollinger?: boolean;
  /** 매물대(볼륨 프로파일) 표시 여부. */
  showVolumeProfile?: boolean;
  /** 매물대 구간 수(기본 30). */
  volumeProfileBins?: number;
  showSupertrend?: boolean;
  currency?: string;
}

// 통화별 가격축 표기. KRW=정수(소수 0, 최소단위 1원).
// USD=커스텀 포매터로 2~4자리(저가주 서브-페니 보존, 큰 가격은 2자리). minMove 0.0001 로 4자리 허용.
function getPriceFormatOptions(currency?: string) {
  if (currency === 'KRW') {
    return { type: 'price' as const, precision: 0, minMove: 1 };
  }
  return {
    type: 'custom' as const,
    minMove: 0.0001,
    formatter: (price: number) =>
      price.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: usdMaxFractionDigits(price),
      }),
  };
}

const HISTORY_LOAD_THRESHOLD = 15;
// 봉 마감 카운트다운을 표시할 최대 봉 간격(초) — 15분 이하 분봉만.
const COUNTDOWN_MAX_INTERVAL_SEC = 15 * 60;

/** '1m'|'5m'|'15m' 같은 분봉 문자열 → 초. 분봉이 아니면 null. */
function parseMinuteIntervalSec(interval?: string): number | null {
  const m = interval?.match(/^(\d+)m$/);
  if (!m) return null;
  const sec = Number(m[1]) * 60;
  return sec > 0 ? sec : null;
}

/** 공백 채움 상한(인터벌 배수) — 이보다 긴 공백(세션 경계·휴장)은 채우지 않고 그대로 둔다. */
const GAP_FILL_MAX_INTERVALS = 24;

/**
 * 거래가 없어 비는 분봉 구간을 직전 종가의 플랫 캔들(거래량 0)로 채운다 — 표시 전용.
 * lightweight-charts 는 데이터에 없는 시각을 축에서 생략해, 한산한 시간대(프리/애프터 등)가
 * 압축돼 보이는 문제를 막는다. 일봉 이상(분봉 아님)이나 큰 공백(밤사이/휴장)은 건드리지 않는다.
 */
function fillCandleGaps(candles: ChartCandle[], intervalSec: number | null): ChartCandle[] {
  if (!intervalSec || candles.length < 2) return candles;
  const out: ChartCandle[] = [candles[0]];
  for (let i = 1; i < candles.length; i += 1) {
    const prev = out[out.length - 1];
    const cur = candles[i];
    const missing = Math.round((cur.time - prev.time) / intervalSec) - 1;
    if (missing > 0 && missing <= GAP_FILL_MAX_INTERVALS) {
      for (let k = 1; k <= missing; k += 1) {
        out.push({
          time: prev.time + k * intervalSec,
          open: prev.close,
          high: prev.close,
          low: prev.close,
          close: prev.close,
          volume: 0,
        });
      }
    }
    out.push(cur);
  }
  return out;
}
const CHART_MIN_HEIGHT = 200;

function getChartHeight(container: HTMLDivElement) {
  return Math.max(container.clientHeight, CHART_MIN_HEIGHT);
}
// 캔들에 집중하도록 거래량 페인 비중 축소 (0.28 → 0.20)
const CANDLE_PANE_STRETCH = 0.8;
const VOLUME_PANE_STRETCH = 0.2;
const PRICE_HEADROOM_RATIO = 0.05; // range-based symmetric headroom for consistent visual whitespace across charts
const BAR_SPACING_DRIFT_THRESHOLD = 0.001;
const RIGHT_OFFSET_DRIFT_THRESHOLD = 0.5;
const CHART_MIN_BAR_SPACING = 0.0001;
const RIGHT_MARGIN_FRACTION = 1 / 3;
// 왼쪽으로 과도하게 밀 때 허용하는 최대 오른쪽 여백(빈 공간) — 화면 폭(보이는 바 수) 대비 비율.
// 이 이상 밀리면 마지막 캔들이 화면 밖으로 완전히 사라지므로 클램프한다(과거/왼쪽 스크롤은 무제한).
const MAX_RIGHT_WHITESPACE_RATIO = 0.5;

interface HoveredCandleOhlc {
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

function formatVolume(value: number) {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return value.toLocaleString('en-US');
}

function formatChartPrice(value: number, currency?: string) {
  if (currency === 'KRW') {
    return Math.round(value).toLocaleString('ko-KR');
  }
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: usdMaxFractionDigits(value),
  });
}

function formatPercentFromOpen(value: number, open: number) {
  if (!Number.isFinite(open) || open === 0) return '';
  const percent = ((value - open) / open) * 100;
  const sign = percent > 0 ? '+' : '';
  return ` (${sign}${percent.toFixed(2)}%)`;
}

function formatOhlcLegendValue(value: number, open: number, currency?: string) {
  return `${formatChartPrice(value, currency)}${formatPercentFromOpen(value, open)}`;
}

// lightweight-charts 는 타임스탬프를 UTC 기준으로 해석해 '날짜 경계(굵은 날짜 눈금)'를
// UTC 자정에 잡는다. UTC 자정(=KST 09시)엔 미국장 캔들이 없어 날짜 라벨이 장 시작 캔들에
// 붙는 문제가 있어, 차트에 넣는 타임스탬프를 KST(+9h)로 시프트한다 → 날짜 경계가 KST 00시.
// 시프트된 시간은 UTC 로 포맷해야 KST 로 표시된다. (도메인 데이터의 타임스탬프는 원본 유지 —
// 시프트는 차트 표시 계층(setData·marker.time)에서만 적용한다)
const KST_OFFSET_SEC = 9 * 3600;
const CHART_TZ = 'UTC';

function toChartTime(sec: number): UTCTimestamp {
  return (sec + KST_OFFSET_SEC) as UTCTimestamp;
}

function formatKstTickMark(time: Time, tickMarkType: TickMarkType): string {
  const date = new Date((time as number) * 1000);
  switch (tickMarkType) {
    case TickMarkType.Year:
      return date.toLocaleDateString('ko-KR', { year: 'numeric', timeZone: CHART_TZ });
    case TickMarkType.Month:
      return date.toLocaleDateString('ko-KR', { month: 'short', timeZone: CHART_TZ });
    case TickMarkType.DayOfMonth:
      return date.toLocaleDateString('ko-KR', { day: 'numeric', month: 'numeric', timeZone: CHART_TZ });
    case TickMarkType.TimeWithSeconds:
      return date.toLocaleTimeString('ko-KR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: CHART_TZ,
      });
    default:
      return date.toLocaleTimeString('ko-KR', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: CHART_TZ,
      });
  }
}

function formatKstCrosshairTime(time: Time): string {
  const date = new Date((time as number) * 1000);
  return date.toLocaleString('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: CHART_TZ,
  });
}

function getCandlePriceScaleOptions() {
  return {
    autoscaleInfoProvider: (
      original: () => { priceRange: { minValue: number; maxValue: number } | null } | null
    ) => {
      const res = original();
      if (!res?.priceRange) return res;

      const { minValue, maxValue } = res.priceRange;
      const range = maxValue - minValue;
      const headroom = range * PRICE_HEADROOM_RATIO;

      return {
        ...res,
        priceRange: {
          minValue: minValue - headroom,
          maxValue: maxValue + headroom,
        },
      };
    },
    scaleMargins: {
      top: 0.05,
      bottom: 0.05,
    },
  };
}

function getTimeScaleWidth(chart: IChartApi) {
  return chart.timeScale().width();
}

function getMarginBars(chart: IChartApi, barSpacing: number) {
  const timeScaleWidth = getTimeScaleWidth(chart);
  if (timeScaleWidth <= 0 || barSpacing <= 0) return 0;
  return (timeScaleWidth / barSpacing) * RIGHT_MARGIN_FRACTION;
}

function resolveBarSpacing(viewport: ChartViewport, chart: IChartApi) {
  if (viewport.barSpacing !== undefined && viewport.barSpacing > 0) {
    return viewport.barSpacing;
  }

  const timeScaleWidth = getTimeScaleWidth(chart);
  const span = viewport.logicalTo - viewport.logicalFrom;
  if (timeScaleWidth <= 0 || span < 0) return null;

  return timeScaleWidth / (span + 1);
}

function isNearRealtimeViewport(viewport: ChartViewport, chart: IChartApi, barSpacing: number) {
  const marginBars = getMarginBars(chart, barSpacing);
  if (marginBars <= 0) return true;

  // 실제 보이는 범위 기준으로 판정 — 마지막 봉이 우측 경계 근처에 있을 때만 실시간 뷰.
  // (기존의 options().rightOffset 은 스크롤해도 변하지 않는 정적 설정값이라, 과거 구간을
  //  보는 중에도 '실시간 근처'로 오판해 새 캔들 도착 시 최신 봉으로 점프하던 버그의 원인)
  if (viewport.lastBarIndex === undefined) return true; // 정보 부족 시 기존(보수적) 동작 유지
  const liveRightOffset = viewport.logicalTo - viewport.lastBarIndex;
  return liveRightOffset >= -2 && liveRightOffset <= marginBars * 1.5;
}

// 최고/최저 마커 라벨용 시각 표기 — KST 'MM.DD HH:mm'
// (원본 타임스탬프를 받으므로 시프트된 축 시간과 달리 Asia/Seoul 로 직접 포맷)
const KST_MARKER_TIME = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function formatMarkerTime(timeSec: number) {
  const parts = KST_MARKER_TIME.formatToParts(new Date(timeSec * 1000));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('month')}.${get('day')} ${get('hour')}:${get('minute')}`;
}

function formatMarkerPrice(value: number) {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: usdMaxFractionDigits(value),
  });
}

/**
 * 보이는 범위 내 최고가/최저가 캔들에 마커(가격 · 현재가 대비 % · 시각)를 만든다.
 * 토스 스타일: 최고=위 화살표(상승색), 최저=아래 화살표(하락색).
 */
function buildHighLowMarkers(
  candles: ChartCandle[],
  range: LogicalRange | null,
  colors: ReturnType<typeof getChartThemeColors>
): SeriesMarker<Time>[] {
  if (candles.length === 0 || !range) return [];

  const from = Math.max(0, Math.ceil(range.from));
  const to = Math.min(candles.length - 1, Math.floor(range.to));
  if (from > to || to - from < 1) return [];

  let hiIdx = from;
  let loIdx = from;
  for (let i = from; i <= to; i += 1) {
    if (candles[i].high > candles[hiIdx].high) hiIdx = i;
    if (candles[i].low < candles[loIdx].low) loIdx = i;
  }

  const current = candles[candles.length - 1]?.close;
  const pctFrom = (extreme: number) => {
    if (!current || current <= 0 || extreme <= 0) return '';
    const pct = ((current - extreme) / extreme) * 100;
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%, `;
  };

  const hi = candles[hiIdx];
  const lo = candles[loIdx];
  return [
    {
      time: toChartTime(hi.time),
      position: 'aboveBar',
      shape: 'arrowDown',
      color: colors.candleUp,
      size: 1,
      text: `${formatMarkerPrice(hi.high)} (${pctFrom(hi.high)}${formatMarkerTime(hi.time)})`,
    },
    {
      time: toChartTime(lo.time),
      position: 'belowBar',
      shape: 'arrowUp',
      color: colors.candleDown,
      size: 1,
      text: `${formatMarkerPrice(lo.low)} (${pctFrom(lo.low)}${formatMarkerTime(lo.time)})`,
    },
  ];
}

/**
 * 저장/복원해도 안전한 뷰포트인지 검증. 폭 0(숨김) 상태에서 캡처됐거나 스케일이 붕괴된
 * 스냅샷(데이터 대비 과대한 논리 범위, 비정상 barSpacing/rightOffset)을 걸러낸다 —
 * 이런 값이 저장·복원되면 캔들이 한 줄로 뭉개진 상태가 재현된다.
 */
function isUsableViewport(viewport: ChartViewport, lastBarIndex: number) {
  const span = viewport.logicalTo - viewport.logicalFrom;
  if (!Number.isFinite(span) || span < 2) return false;

  const bars = Math.max(1, lastBarIndex + 1);
  if (span > bars * 4 + 240) return false; // 데이터 대비 과대 축소(스케일 붕괴) 스냅샷

  if (
    viewport.barSpacing !== undefined &&
    (!Number.isFinite(viewport.barSpacing) || viewport.barSpacing <= 0 || viewport.barSpacing > 100)
  ) {
    return false;
  }
  if (
    viewport.rightOffset !== undefined &&
    (!Number.isFinite(viewport.rightOffset) ||
      viewport.rightOffset < -bars ||
      viewport.rightOffset > span * 2)
  ) {
    return false;
  }
  return true;
}

function captureChartViewport(chart: IChartApi, lastBarIndex: number): ChartViewport | null {
  const timeRange = chart.timeScale().getVisibleRange();
  const logicalRange = chart.timeScale().getVisibleLogicalRange();
  if (!timeRange || !logicalRange) return null;

  const options = chart.timeScale().options();

  return {
    timeFrom: timeRange.from as number,
    timeTo: timeRange.to as number,
    logicalFrom: logicalRange.from,
    logicalTo: logicalRange.to,
    barSpacing: options.barSpacing,
    rightOffset: options.rightOffset,
    lastBarIndex,
  };
}

function hasViewportSpacingDrift(
  beforeBarSpacing: number,
  beforeRightOffset: number | undefined,
  afterBarSpacing: number,
  afterRightOffset: number
) {
  return (
    Math.abs(afterBarSpacing - beforeBarSpacing) > BAR_SPACING_DRIFT_THRESHOLD ||
    (beforeRightOffset !== undefined &&
      Math.abs(afterRightOffset - beforeRightOffset) > RIGHT_OFFSET_DRIFT_THRESHOLD)
  );
}

function applyViewportSpacing(
  chart: IChartApi,
  viewport: ChartViewport,
  options?: { forceRealtimeMargin?: boolean }
) {
  const barSpacing = resolveBarSpacing(viewport, chart);
  if (!barSpacing) return false;

  const marginBars = getMarginBars(chart, barSpacing);
  let rightOffset = viewport.rightOffset ?? marginBars;

  if (options?.forceRealtimeMargin || isNearRealtimeViewport(viewport, chart, barSpacing)) {
    rightOffset = marginBars;
  }

  chart.timeScale().applyOptions({
    minBarSpacing: CHART_MIN_BAR_SPACING,
    barSpacing,
    rightOffset,
  });

  return true;
}

function enforceRealtimeRightMargin(chart: IChartApi, lastBarIndex: number) {
  const lr = chart.timeScale().getVisibleLogicalRange();
  if (!lr) return;
  const barSpacing = chart.timeScale().options().barSpacing;
  if (!barSpacing || barSpacing <= 0) return;
  const marginBars = getMarginBars(chart, barSpacing);
  const span = lr.to - lr.from;
  const desiredTo = lastBarIndex + marginBars;
  const desiredFrom = Math.max(0, desiredTo - span);
  const actualTo = desiredFrom + span;
  chart.timeScale().setVisibleLogicalRange({ from: desiredFrom, to: actualTo });
  chart.timeScale().applyOptions({
    minBarSpacing: CHART_MIN_BAR_SPACING,
    rightOffset: actualTo - lastBarIndex,
  });
}

function applyInitialViewport(chart: IChartApi, lastBarIndex: number) {
  chart.timeScale().applyOptions({
    minBarSpacing: CHART_MIN_BAR_SPACING,
  });
  chart.timeScale().fitContent();
  requestAnimationFrame(() => {
    enforceRealtimeRightMargin(chart, lastBarIndex);
  });
}

function getBollingerLineOptions(color: string, title: string, lineStyle: LineStyle) {
  return {
    color,
    lineWidth: 1 as const,
    lineStyle,
    title,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  };
}

function applyChartTheme(
  chart: IChartApi,
  series: ISeriesApi<'Candlestick'>,
  bollingerSeries: {
    upper: ISeriesApi<'Line'> | null;
    middle: ISeriesApi<'Line'> | null;
    lower: ISeriesApi<'Line'> | null;
    fill: BollingerBandFillPrimitive | null;
  },
  colors: ReturnType<typeof getChartThemeColors>
) {
  chart.applyOptions({
    layout: {
      background: { type: ColorType.Solid, color: colors.background },
      textColor: colors.text,
      panes: {
        enableResize: true,
        separatorColor: colors.separator,
        separatorHoverColor: colors.separatorHover,
      },
    },
    grid: {
      vertLines: { color: colors.grid, style: LineStyle.Dotted },
      horzLines: { color: colors.grid, style: LineStyle.Dotted },
    },
    rightPriceScale: {
      borderColor: colors.border,
    },
    timeScale: {
      borderColor: colors.border,
    },
    crosshair: {
      vertLine: { color: colors.crosshair },
      horzLine: { color: colors.crosshair },
    },
  });

  series.applyOptions({
    upColor: colors.candleUp,
    downColor: colors.candleDown,
    wickUpColor: colors.candleUp,
    wickDownColor: colors.candleDown,
  });

  bollingerSeries.upper?.applyOptions(
    getBollingerLineOptions(colors.bollingerUpper, 'BB 상단', LineStyle.Dashed)
  );
  bollingerSeries.middle?.applyOptions(
    getBollingerLineOptions(colors.bollingerMiddle, 'BB 중간', LineStyle.Solid)
  );
  bollingerSeries.lower?.applyOptions(
    getBollingerLineOptions(colors.bollingerLower, 'BB 하단', LineStyle.Dashed)
  );
  bollingerSeries.fill?.setFillColor(colors.bollingerFill);

  chart.panes()[1]?.priceScale('right').applyOptions({
    borderColor: colors.border,
  });
}

export function CandleChart({
  candles,
  averagePrice,
  loading,
  error,
  fitKey,
  candleInterval,
  hasMoreHistory = false,
  loadingOlder = false,
  onLoadOlder,
  showBollinger = true,
  showVolumeProfile = true,
  volumeProfileBins = 30,
  showSupertrend = false,
  currency = 'USD',
}: CandleChartProps) {
  const { theme } = useTheme();
  const currencyRef = useRef(currency);
  currencyRef.current = currency;
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const bbUpperSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbMiddleSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbLowerSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbFillPrimitiveRef = useRef<BollingerBandFillPrimitive | null>(null);
  const volumeProfilePrimitiveRef = useRef<VolumeProfilePrimitive | null>(null);
  const showVolumeProfileRef = useRef(showVolumeProfile);
  showVolumeProfileRef.current = showVolumeProfile;
  const volumeProfileBinsRef = useRef(volumeProfileBins);
  volumeProfileBinsRef.current = volumeProfileBins;
  // 슈퍼트렌드: 상승/하락 구간을 색으로 구분하기 위해 두 라인 시리즈로 분리(상승=빨강/하락=파랑).
  const stUpSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const stDownSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const avgPriceLineRef = useRef<IPriceLine | null>(null);
  const prevFirstTimeRef = useRef<number | null>(null);
  const prevDataLengthRef = useRef<number | null>(null);
  const onLoadOlderRef = useRef(onLoadOlder);
  const hasMoreHistoryRef = useRef(hasMoreHistory);
  const loadingOlderRef = useRef(loadingOlder);
  const fitKeyRef = useRef(fitKey);
  const viewportInitializedRef = useRef(false);
  const pendingRestoreRef = useRef<ChartViewport | null>(null);
  // 차트가 숨겨진(display:none, 폭 0) 상태에서 데이터가 도착하면 초기화(fit/복원)를 미루고,
  // 보이는 순간(ResizeObserver 폭 > 0) 수행한다 — 폭 0에서 fitContent 하면 스케일이 깨진다.
  const needsInitOnVisibleRef = useRef(false);
  const lastBarIndexRef = useRef(0);
  const chartWidthRef = useRef(0);
  // 보이는 범위 내 최고/최저 마커 — 팬/줌 시 rAF 로 스로틀해 갱신.
  const markersApiRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const sortedCandlesRef = useRef<ChartCandle[]>([]);
  const markersUpdateScheduledRef = useRef(false);
  const [hoveredCandle, setHoveredCandle] = useState<HoveredCandleOhlc | null>(null);
  // 봉 마감 카운트다운(분:초) — 15분 이하 분봉에서 현재가 라벨 아래에 표시.
  const [barCountdown, setBarCountdown] = useState<{
    text: string;
    y: number;
    axisWidth: number;
    color: string;
  } | null>(null);
  const countdownIntervalSecRef = useRef<number | null>(null);

  onLoadOlderRef.current = onLoadOlder;
  hasMoreHistoryRef.current = hasMoreHistory;
  loadingOlderRef.current = loadingOlder;
  fitKeyRef.current = fitKey;

  useEffect(() => {
    pendingRestoreRef.current = fitKey ? getStoredChartViewport(fitKey) : null;
    viewportInitializedRef.current = false;
    needsInitOnVisibleRef.current = false;
    prevDataLengthRef.current = null;
  }, [fitKey]);

  // 초기 뷰포트 설정(저장된 뷰포트 복원 or 전체 fit). 반드시 차트 폭 > 0 일 때 호출한다.
  const initializeViewportNow = (chart: IChartApi, lastBarIndex: number) => {
    const pending = pendingRestoreRef.current;
    pendingRestoreRef.current = null;
    viewportInitializedRef.current = true;
    // 저장된 뷰포트가 스케일 붕괴 스냅샷(과거 버그로 저장된 오염 데이터 포함)이면 버리고
    // 전체 fit 으로 자가 치유한다.
    if (pending && isUsableViewport(pending, lastBarIndex)) {
      applyViewportSpacing(chart, pending);
      requestAnimationFrame(() => {
        enforceRealtimeRightMargin(chart, lastBarIndex);
      });
      return;
    }
    applyInitialViewport(chart, lastBarIndex);
  };
  const initializeViewportNowRef = useRef(initializeViewportNow);
  initializeViewportNowRef.current = initializeViewportNow;

  // 보이는 범위 파생 오버레이(최고/최저 마커 + 매물대) 갱신 — rAF 스로틀로 팬/줌 중 과도한 재계산 방지.
  // 입력(보이는 범위·캔들·설정·테마)이 직전과 같으면 통째로 생략 — 폴링/재렌더마다 동일 값으로
  // setMarkers/setProfile 을 다시 호출하면 불필요한 전체 재도장이 반복돼 차트가 떨려 보인다.
  const overlaySignatureRef = useRef<string | null>(null);
  const scheduleHighLowMarkersUpdate = () => {
    if (markersUpdateScheduledRef.current) return;
    markersUpdateScheduledRef.current = true;
    requestAnimationFrame(() => {
      markersUpdateScheduledRef.current = false;
      const chart = chartRef.current;
      const markersApi = markersApiRef.current;
      if (!chart || !markersApi) return;
      const range = chart.timeScale().getVisibleLogicalRange();

      const candlesAll = sortedCandlesRef.current;
      let visibleCandles = candlesAll;
      let from = 0;
      let to = candlesAll.length - 1;
      if (range) {
        from = Math.max(0, Math.ceil(range.from));
        to = Math.min(candlesAll.length - 1, Math.floor(range.to));
        visibleCandles = from <= to ? candlesAll.slice(from, to + 1) : [];
      }

      // 데이터 스왑/전환 순간의 일시적 빈 범위 — 이전 오버레이를 유지(지웠다 다시 그리는 깜빡임 방지).
      if (candlesAll.length > 0 && visibleCandles.length === 0) return;

      const colors = getChartThemeColors();
      const lastVis = visibleCandles[visibleCandles.length - 1];
      const signature = [
        from,
        to,
        candlesAll.length,
        lastVis?.time ?? 0,
        lastVis?.close ?? 0,
        lastVis?.volume ?? 0,
        volumeProfileBinsRef.current,
        colors.candleUp,
      ].join(':');
      if (signature === overlaySignatureRef.current) return;
      overlaySignatureRef.current = signature;

      markersApi.setMarkers(buildHighLowMarkers(candlesAll, range, colors));
      // 매물대 — 실제 렌더링 중인(보이는) 캔들만으로 계산해 팬/줌을 따라간다.
      volumeProfilePrimitiveRef.current?.setProfile(
        buildVolumeProfile(visibleCandles, volumeProfileBinsRef.current)
      );
    });
  };
  const scheduleHighLowMarkersUpdateRef = useRef(scheduleHighLowMarkersUpdate);
  scheduleHighLowMarkersUpdateRef.current = scheduleHighLowMarkersUpdate;

  useEffect(() => {
    if (!containerRef.current) return;

    const colors = getChartThemeColors();

    chartWidthRef.current = containerRef.current.clientWidth;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: colors.background },
        textColor: colors.text,
        // lightweight-charts 는 series title(예: 'BB 상단/중간/하단') 라벨 폰트를 차트 전역
        // fontSize 에 묶는다(라벨별 지정 불가). BB 라벨을 작게 보이도록 전역 폰트를 축소.
        fontSize: 10,
        panes: {
          enableResize: true,
          separatorColor: colors.separator,
          separatorHoverColor: colors.separatorHover,
        },
      },
      grid: {
        vertLines: { color: colors.grid, style: LineStyle.Dotted },
        horzLines: { color: colors.grid, style: LineStyle.Dotted },
      },
      rightPriceScale: {
        borderColor: colors.border,
      },
      localization: {
        locale: 'ko-KR',
        timeFormatter: formatKstCrosshairTime,
      },
      timeScale: {
        borderColor: colors.border,
        timeVisible: true,
        secondsVisible: false,
        minBarSpacing: CHART_MIN_BAR_SPACING,
        tickMarkFormatter: formatKstTickMark,
      },
      crosshair: {
        vertLine: { color: colors.crosshair },
        horzLine: { color: colors.crosshair },
      },
      width: containerRef.current.clientWidth,
      height: getChartHeight(containerRef.current),
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: colors.candleUp,
      downColor: colors.candleDown,
      borderVisible: false,
      wickUpColor: colors.candleUp,
      wickDownColor: colors.candleDown,
      priceFormat: getPriceFormatOptions(currencyRef.current),
    });

    series.applyOptions(getCandlePriceScaleOptions());

    // 매물대(볼륨 프로파일) — 캔들 pane 좌측 가로 바. 캔들 시리즈 좌표계를 사용.
    const volumeProfilePrimitive = new VolumeProfilePrimitive();
    volumeProfilePrimitive.setColor(colors.candleDown);
    volumeProfilePrimitive.setVisible(showVolumeProfileRef.current);
    series.attachPrimitive(volumeProfilePrimitive);
    volumeProfilePrimitiveRef.current = volumeProfilePrimitive;

    const bbUpperSeries = chart.addSeries(
      LineSeries,
      getBollingerLineOptions(colors.bollingerUpper, 'BB 상단', LineStyle.Dashed),
      0
    );
    const bbMiddleSeries = chart.addSeries(
      LineSeries,
      getBollingerLineOptions(colors.bollingerMiddle, 'BB 중간', LineStyle.Solid),
      0
    );
    const bbLowerSeries = chart.addSeries(
      LineSeries,
      getBollingerLineOptions(colors.bollingerLower, 'BB 하단', LineStyle.Dashed),
      0
    );
    const bbFillPrimitive = new BollingerBandFillPrimitive();
    bbFillPrimitive.setFillColor(colors.bollingerFill);
    bbMiddleSeries.attachPrimitive(bbFillPrimitive);

    // 슈퍼트렌드 — 상승(빨강)/하락(파랑) 두 라인. 색만 다르고 동일 스타일.
    const stLineOptions = {
      lineWidth: 2 as const,
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
      visible: showSupertrend,
    };
    const stUpSeries = chart.addSeries(
      LineSeries,
      { ...stLineOptions, color: colors.candleUp, title: '슈퍼트렌드' },
      0
    );
    const stDownSeries = chart.addSeries(
      LineSeries,
      { ...stLineOptions, color: colors.candleDown, title: '' },
      0
    );

    const volumeSeries = chart.addSeries(
      HistogramSeries,
      {
        priceFormat: { type: 'volume' },
        title: '거래량',
        lastValueVisible: true,
        priceLineVisible: false,
      },
      1
    );

    const [candlePane, volumePane] = chart.panes();
    candlePane.setStretchFactor(CANDLE_PANE_STRETCH);
    volumePane.setStretchFactor(VOLUME_PANE_STRETCH);

    volumePane.priceScale('right').applyOptions({
      scaleMargins: {
        top: 0.1,
        bottom: 0.05,
      },
      borderColor: colors.border,
    });

    markersApiRef.current = createSeriesMarkers(series, []);

    chartRef.current = chart;
    seriesRef.current = series;
    bbUpperSeriesRef.current = bbUpperSeries;
    bbMiddleSeriesRef.current = bbMiddleSeries;
    bbLowerSeriesRef.current = bbLowerSeries;
    bbFillPrimitiveRef.current = bbFillPrimitive;
    stUpSeriesRef.current = stUpSeries;
    stDownSeriesRef.current = stDownSeries;
    volumeSeriesRef.current = volumeSeries;

    const saveViewportIfReady = (targetChart: IChartApi = chart) => {
      if (!viewportInitializedRef.current) return;

      const currentFitKey = fitKeyRef.current;
      if (!currentFitKey) return;

      // 숨김(폭 0) 상태나 스케일이 붕괴된 스냅샷은 저장하지 않는다 —
      // 오염된 뷰포트가 저장되면 다음 방문 때 깨진 배율이 그대로 복원된다.
      if (getTimeScaleWidth(targetChart) <= 0) return;
      const viewport = captureChartViewport(targetChart, lastBarIndexRef.current);
      if (viewport && isUsableViewport(viewport, lastBarIndexRef.current)) {
        setStoredChartViewport(currentFitKey, viewport);
      }
    };

    const handlePageHide = () => {
      saveViewportIfReady(chart);
    };

    window.addEventListener('pagehide', handlePageHide);

    let clampingViewport = false;
    const handleVisibleRangeChange = (range: LogicalRange | null) => {
      if (!range) return;

      // 오른쪽 여백 한계: 왼쪽으로 과도하게 밀려 마지막 캔들이 화면 밖으로 완전히 사라지는 것 방지.
      // 오른쪽 여백(마지막 캔들 이후 빈 공간)이 화면 폭의 MAX_RIGHT_WHITESPACE_RATIO 를 넘으면
      // 같은 확대율(span)을 유지한 채 되돌린다. 과거(왼쪽) 스크롤은 제한하지 않는다.
      const span = range.to - range.from;
      const lastBarIndex = lastBarIndexRef.current;
      if (!clampingViewport && span > 0 && lastBarIndex >= 0) {
        const maxRightWhitespace = span * MAX_RIGHT_WHITESPACE_RATIO;
        if (range.to - lastBarIndex > maxRightWhitespace) {
          clampingViewport = true;
          const clampedTo = lastBarIndex + maxRightWhitespace;
          chart.timeScale().setVisibleLogicalRange({ from: clampedTo - span, to: clampedTo });
          requestAnimationFrame(() => {
            clampingViewport = false;
          });
          return;
        }
      }

      // 보이는 범위가 바뀔 때마다 범위 내 최고/최저 마커 갱신
      scheduleHighLowMarkersUpdateRef.current();

      if (loadingOlderRef.current || !hasMoreHistoryRef.current) return;
      if (range.from < HISTORY_LOAD_THRESHOLD) {
        onLoadOlderRef.current?.();
      }
    };

    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleRangeChange);

    const handleCrosshairMove = (param: {
      point?: { x: number; y: number };
      time?: unknown;
      seriesData: Map<unknown, unknown>;
    }) => {
      const container = containerRef.current;
      if (
        !param.point ||
        param.time === undefined ||
        !container ||
        param.point.x < 0 ||
        param.point.y < 0 ||
        param.point.x > container.clientWidth ||
        param.point.y > container.clientHeight
      ) {
        setHoveredCandle(null);
        return;
      }

      const data = param.seriesData.get(series);
      if (
        !data ||
        typeof data !== 'object' ||
        !('open' in data) ||
        !('high' in data) ||
        !('low' in data) ||
        !('close' in data)
      ) {
        setHoveredCandle(null);
        return;
      }

      const candle = data as HoveredCandleOhlc;

      // 거래량 히스토그램 시리즈에서 같은 시점의 value(거래량)를 읽는다.
      let volume: number | undefined;
      const volSeries = volumeSeriesRef.current;
      const volData = volSeries ? param.seriesData.get(volSeries) : undefined;
      if (volData && typeof volData === 'object' && 'value' in volData) {
        const v = (volData as { value: unknown }).value;
        if (typeof v === 'number') volume = v;
      }

      setHoveredCandle({
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume,
      });
    };

    chart.subscribeCrosshairMove(handleCrosshairMove);

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || !chartRef.current) return;
      const newWidth = entry.contentRect.width;
      // 숨김(display:none, 폭 0) — 0으로 리사이즈하거나 스케일 연산을 하지 않는다.
      // 내부 시간축 상태를 보존해 다시 보일 때 기존 배율 그대로 복귀하게 한다.
      if (newWidth <= 0) {
        chartWidthRef.current = 0;
        return;
      }
      chartWidthRef.current = newWidth;
      const newHeight = Math.max(entry.contentRect.height, CHART_MIN_HEIGHT);

      // resize()를 사용해 크기를 즉시 반영 (applyOptions와 동일하지만 명확)
      chartRef.current.resize(newWidth, newHeight);

      // 높이 변경 시 가격 스케일(autoscale + headroom)과 pane stretch를 재적용해
      // 새 높이에 맞춰 캔들/볼륨 영역이 제대로 재분배되도록 함.
      if (seriesRef.current) {
        seriesRef.current.applyOptions(getCandlePriceScaleOptions());
      }
      const panes = chartRef.current.panes();
      if (panes.length >= 2) {
        panes[0].setStretchFactor(CANDLE_PANE_STRETCH);
        panes[1].setStretchFactor(VOLUME_PANE_STRETCH);
      }

      // 숨김 상태에서 미뤄둔 초기 뷰포트 설정(fit/복원)을 보이는 순간 수행.
      if (needsInitOnVisibleRef.current && newWidth > 0) {
        needsInitOnVisibleRef.current = false;
        requestAnimationFrame(() => {
          if (chartRef.current) {
            initializeViewportNowRef.current(chartRef.current, lastBarIndexRef.current);
          }
        });
        return; // 초기화가 fit + 우측 여백까지 처리하므로 아래 재강제는 생략
      }

      // 가로 크기 변화에 대해 1/3 오른쪽 여백 위치를 재강제 (rAF로 settle 대기)
      if (lastBarIndexRef.current != null) {
        requestAnimationFrame(() => {
          if (chartRef.current) {
            enforceRealtimeRightMargin(chartRef.current, lastBarIndexRef.current);
          }
        });
      }
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      saveViewportIfReady(chart);

      resizeObserver.disconnect();
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVisibleRangeChange);
      setHoveredCandle(null);
      chart.remove();
      chartRef.current = null;
      markersApiRef.current = null;
      seriesRef.current = null;
      volumeProfilePrimitiveRef.current = null;
      bbUpperSeriesRef.current = null;
      bbMiddleSeriesRef.current = null;
      bbLowerSeriesRef.current = null;
      bbFillPrimitiveRef.current = null;
      stUpSeriesRef.current = null;
      stDownSeriesRef.current = null;
      volumeSeriesRef.current = null;
      avgPriceLineRef.current = null;
    };
  }, []);

  // 봉 마감 카운트다운 갱신 — 남은 시간·y 좌표·방향색(현재가 라벨과 동일)을 계산.
  // 1초 타이머 + 캔들 데이터 변경 양쪽에서 호출해 라벨 위치를 늦지 않게 따라간다.
  const updateBarCountdown = () => {
    const intervalSec = countdownIntervalSecRef.current;
    const chart = chartRef.current;
    const series = seriesRef.current;
    const last = sortedCandlesRef.current[sortedCandlesRef.current.length - 1];
    if (!intervalSec || !chart || !series || !last || chartWidthRef.current <= 0) {
      setBarCountdown(null);
      return;
    }
    const nowSec = Date.now() / 1000;
    let remain = last.time + intervalSec - nowSec;
    // 데이터 지연/폐장 등으로 범위를 벗어나면 벽시계 기준 경계로 폴백
    if (remain <= 0 || remain > intervalSec) remain = intervalSec - (nowSec % intervalSec);
    const y = series.priceToCoordinate(last.close);
    if (y == null) {
      setBarCountdown(null);
      return;
    }
    const colors = getChartThemeColors();
    const minutes = Math.floor(remain / 60);
    const seconds = Math.floor(remain % 60);
    setBarCountdown({
      text: `${minutes}:${String(seconds).padStart(2, '0')}`,
      y: Math.round(y) + 9, // 현재가 축 라벨(높이 ~18px) 바로 아래 밀착
      axisWidth: chart.priceScale('right').width(),
      // 현재가 라벨과 같은 방향색 → 라벨과 한 덩어리로 읽힘
      color: last.close >= last.open ? colors.candleUp : colors.candleDown,
    });
  };
  const updateBarCountdownRef = useRef(updateBarCountdown);
  updateBarCountdownRef.current = updateBarCountdown;

  useEffect(() => {
    const intervalSec = parseMinuteIntervalSec(candleInterval);
    countdownIntervalSecRef.current =
      intervalSec && intervalSec <= COUNTDOWN_MAX_INTERVAL_SEC ? intervalSec : null;
    if (!countdownIntervalSecRef.current) {
      setBarCountdown(null);
      return;
    }
    updateBarCountdownRef.current();
    const id = setInterval(() => updateBarCountdownRef.current(), 1000);
    return () => clearInterval(id);
  }, [candleInterval]);

  useEffect(() => {
    if (!chartRef.current || !seriesRef.current) return;
    applyChartTheme(
      chartRef.current,
      seriesRef.current,
      {
        upper: bbUpperSeriesRef.current,
        middle: bbMiddleSeriesRef.current,
        lower: bbLowerSeriesRef.current,
        fill: bbFillPrimitiveRef.current,
      },
      getChartThemeColors()
    );
    volumeProfilePrimitiveRef.current?.setColor(getChartThemeColors().candleDown);
    scheduleHighLowMarkersUpdateRef.current(); // 테마 색 반영
  }, [theme]);

  // 볼린저밴드 on/off — 라인 3종 + 채움 primitive 의 표시 여부만 토글(데이터는 유지).
  useEffect(() => {
    bbUpperSeriesRef.current?.applyOptions({ visible: showBollinger });
    bbMiddleSeriesRef.current?.applyOptions({ visible: showBollinger });
    bbLowerSeriesRef.current?.applyOptions({ visible: showBollinger });
    bbFillPrimitiveRef.current?.setVisible(showBollinger);
  }, [showBollinger]);

  // 매물대 on/off — primitive 표시 여부만 토글(데이터는 유지).
  useEffect(() => {
    volumeProfilePrimitiveRef.current?.setVisible(showVolumeProfile);
  }, [showVolumeProfile]);

  // 매물대 구간 수 변경 — 보이는 구간 기준으로 재계산.
  useEffect(() => {
    scheduleHighLowMarkersUpdateRef.current();
  }, [volumeProfileBins]);

  // 슈퍼트렌드 on/off — 상승/하락 라인 표시 토글(데이터는 유지).
  useEffect(() => {
    stUpSeriesRef.current?.applyOptions({ visible: showSupertrend });
    stDownSeriesRef.current?.applyOptions({ visible: showSupertrend });
  }, [showSupertrend]);

  useEffect(() => {
    if (!seriesRef.current) return;

    const colors = getChartThemeColors();

    if (averagePrice === undefined || averagePrice <= 0) {
      if (avgPriceLineRef.current) {
        seriesRef.current.removePriceLine(avgPriceLineRef.current);
        avgPriceLineRef.current = null;
      }
      return;
    }

    const lineOptions = {
      price: averagePrice,
      color: colors.avgPriceLine,
      lineWidth: 1 as const,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: '평단',
      axisLabelColor: colors.avgPriceLine,
      axisLabelTextColor: colors.avgPriceLabelText,
    };

    if (avgPriceLineRef.current) {
      avgPriceLineRef.current.applyOptions(lineOptions);
      return;
    }

    avgPriceLineRef.current = seriesRef.current.createPriceLine(lineOptions);
  }, [averagePrice, theme]);

  // 통화 변경(US↔KR) 시 가격축/가격선 정밀도를 갱신한다.
  useEffect(() => {
    seriesRef.current?.applyOptions({ priceFormat: getPriceFormatOptions(currency) });
  }, [currency]);

  useEffect(() => {
    if (!seriesRef.current || !volumeSeriesRef.current) return;

    const colors = getChartThemeColors();
    // 정렬 후 공백 분봉 채움 — 거래 없는 시간대도 시간축에 연속으로 렌더링되게(표시 전용).
    const sortedCandles = fillCandleGaps(
      candles.slice().sort((a, b) => a.time - b.time),
      parseMinuteIntervalSec(candleInterval)
    );

    const data = sortedCandles.map((candle) => ({
      time: toChartTime(candle.time),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    }));

    const volumeData = sortedCandles.map((candle) => ({
      time: toChartTime(candle.time),
      value: candle.volume,
      color: candle.close >= candle.open ? colors.candleUp : colors.candleDown,
    }));

    const prevFirstTime = prevFirstTimeRef.current;
    const newFirstTime = data[0]?.time ?? null;
    const prependedCount =
      prevFirstTime !== null && newFirstTime !== null && newFirstTime < prevFirstTime
        ? data.filter((candle) => candle.time < prevFirstTime).length
        : 0;

    const chart = chartRef.current;
    if (!chart || data.length === 0) return;

    const lastBarIndex = data.length - 1;
    lastBarIndexRef.current = lastBarIndex;

    const dataLengthChanged =
      prevDataLengthRef.current !== null && data.length !== prevDataLengthRef.current;
    const isStructuralChange =
      prependedCount > 0 || prevDataLengthRef.current === null || dataLengthChanged;

    const visibleRange = prependedCount > 0 ? chart.timeScale().getVisibleLogicalRange() : null;
    const logicalRangeBeforeUpdate =
      viewportInitializedRef.current && isStructuralChange
        ? chart.timeScale().getVisibleLogicalRange()
        : null;
    const timeRangeBeforeUpdate =
      viewportInitializedRef.current && isStructuralChange
        ? chart.timeScale().getVisibleRange()
        : null;
    const barSpacingBeforeUpdate =
      viewportInitializedRef.current && isStructuralChange
        ? chart.timeScale().options().barSpacing
        : undefined;
    const rightOffsetBeforeUpdate =
      viewportInitializedRef.current && isStructuralChange
        ? chart.timeScale().options().rightOffset
        : undefined;

    seriesRef.current.setData(data);
    volumeSeriesRef.current.setData(volumeData);

    // 밴드 시간도 차트 표시 시간(KST 시프트)으로 통일 — fill primitive 의
    // timeToCoordinate 조회가 시리즈 타임스탬프와 일치해야 한다.
    const bollingerBands = calculateBollingerBandSeries(sortedCandles).map((point) => ({
      ...point,
      time: toChartTime(point.time) as number,
    }));
    const upperBandData = bollingerBands.map((point) => ({
      time: point.time as UTCTimestamp,
      value: point.upper,
    }));
    const middleBandData = bollingerBands.map((point) => ({
      time: point.time as UTCTimestamp,
      value: point.middle,
    }));
    const lowerBandData = bollingerBands.map((point) => ({
      time: point.time as UTCTimestamp,
      value: point.lower,
    }));

    bbUpperSeriesRef.current?.setData(upperBandData);
    bbMiddleSeriesRef.current?.setData(middleBandData);
    bbLowerSeriesRef.current?.setData(lowerBandData);
    bbFillPrimitiveRef.current?.setBands(bollingerBands);

    // 슈퍼트렌드: 상승/하락을 두 라인으로 분리(상승=빨강, 하락=파랑). 비활성 구간은 whitespace 로
    // 끊고, 추세 전환봉에선 이전 봉 점을 새 라인에도 넣어 색 경계가 끊기지 않게 연결한다.
    const supertrend = calculateSupertrendSeries(sortedCandles);
    type StDatum = { time: UTCTimestamp; value: number } | { time: UTCTimestamp };
    const stUp: StDatum[] = supertrend.map((p) => ({ time: toChartTime(p.time) }));
    const stDown: StDatum[] = supertrend.map((p) => ({ time: toChartTime(p.time) }));
    for (let i = 0; i < supertrend.length; i += 1) {
      const p = supertrend[i];
      const point = { time: toChartTime(p.time), value: p.value };
      if (p.dir === 'up') stUp[i] = point;
      else stDown[i] = point;
      if (i > 0 && supertrend[i].dir !== supertrend[i - 1].dir) {
        const prev = supertrend[i - 1];
        const prevPoint = { time: toChartTime(prev.time), value: prev.value };
        if (p.dir === 'up') stUp[i - 1] = prevPoint;
        else stDown[i - 1] = prevPoint;
      }
    }
    stUpSeriesRef.current?.setData(stUp);
    stDownSeriesRef.current?.setData(stDown);

    if (visibleRange && prependedCount > 0) {
      const from = Math.max(0, visibleRange.from + prependedCount);
      const to = Math.max(from, visibleRange.to + prependedCount);
      chart.timeScale().setVisibleLogicalRange({ from, to });

      if (barSpacingBeforeUpdate !== undefined) {
        chart.timeScale().applyOptions({
          barSpacing: barSpacingBeforeUpdate,
          ...(rightOffsetBeforeUpdate !== undefined
            ? { rightOffset: rightOffsetBeforeUpdate }
            : {}),
        });
      }
    } else if (pendingRestoreRef.current || !viewportInitializedRef.current) {
      if (getTimeScaleWidth(chart) > 0) {
        needsInitOnVisibleRef.current = false;
        initializeViewportNow(chart, lastBarIndex);
      } else {
        // 차트가 숨겨진 탭(display:none, 폭 0)에서 종목이 바뀐 경우 — 여기서 fit/복원하면
        // 스케일이 깨진 채 고정된다. 보이는 순간(ResizeObserver) 초기화하도록 미룬다.
        needsInitOnVisibleRef.current = true;
      }
    } else if (
      isStructuralChange &&
      barSpacingBeforeUpdate !== undefined &&
      barSpacingBeforeUpdate > 0
    ) {
      const liveViewport: ChartViewport = {
        timeFrom: (timeRangeBeforeUpdate?.from as number) ?? 0,
        timeTo: (timeRangeBeforeUpdate?.to as number) ?? 0,
        logicalFrom: logicalRangeBeforeUpdate?.from ?? 0,
        logicalTo: logicalRangeBeforeUpdate?.to ?? lastBarIndex,
        barSpacing: barSpacingBeforeUpdate,
        rightOffset: rightOffsetBeforeUpdate,
        lastBarIndex: Math.max(0, (prevDataLengthRef.current ?? data.length) - 1),
      };
      const optionsAfterUpdate = chart.timeScale().options();
      const wasNearRealtime = isNearRealtimeViewport(liveViewport, chart, barSpacingBeforeUpdate);

      if (dataLengthChanged && prependedCount === 0 && wasNearRealtime) {
        enforceRealtimeRightMargin(chart, lastBarIndex);
      } else if (
        hasViewportSpacingDrift(
          barSpacingBeforeUpdate,
          rightOffsetBeforeUpdate,
          optionsAfterUpdate.barSpacing,
          optionsAfterUpdate.rightOffset
        )
      ) {
        applyViewportSpacing(chart, liveViewport);
      }
    }

    prevFirstTimeRef.current = newFirstTime;
    prevDataLengthRef.current = data.length;

    // 데이터 갱신 후 보이는 범위 기준 최고/최저 마커 갱신 (뷰포트 적용이 settle 된 뒤 rAF 로)
    sortedCandlesRef.current = sortedCandles;
    scheduleHighLowMarkersUpdateRef.current(); // 마커 + 매물대(보이는 구간) 갱신
    updateBarCountdownRef.current(); // 현재가 라벨 이동을 즉시 추적
  }, [candles, fitKey, candleInterval]);

  const chartStatus = loading
    ? '캔들 불러오는 중…'
    : loadingOlder
      ? '과거 캔들 불러오는 중…'
      : error
        ? error
        : candles.length === 0
          ? '캔들 데이터가 없습니다.'
          : null;

  const isUpCandle = hoveredCandle !== null && hoveredCandle.close >= hoveredCandle.open;

  return (
    <div className="chart-block">
      {chartStatus && (
        <Typography as="p" size={14} className={`chart-status${error ? ' error-text' : ' hint'}`}>
          {chartStatus}
        </Typography>
      )}
      {hoveredCandle && (
        <div className="chart-ohlc-legend" aria-live="polite">
          <Typography size={12} className="chart-ohlc-legend__item">
            시가{' '}
            <Typography as="strong" size={12}>
              {formatOhlcLegendValue(hoveredCandle.open, hoveredCandle.open, currency)}
            </Typography>
          </Typography>
          <Typography size={12} className="chart-ohlc-legend__item up">
            고가{' '}
            <Typography as="strong" size={12}>
              {formatOhlcLegendValue(hoveredCandle.high, hoveredCandle.open, currency)}
            </Typography>
          </Typography>
          <Typography size={12} className="chart-ohlc-legend__item down">
            저가{' '}
            <Typography as="strong" size={12}>
              {formatOhlcLegendValue(hoveredCandle.low, hoveredCandle.open, currency)}
            </Typography>
          </Typography>
          <Typography size={12} className={`chart-ohlc-legend__item${isUpCandle ? ' up' : ' down'}`}>
            종가{' '}
            <Typography as="strong" size={12}>
              {formatOhlcLegendValue(hoveredCandle.close, hoveredCandle.open, currency)}
            </Typography>
          </Typography>
          {hoveredCandle.volume !== undefined && (
            <Typography size={12} className="chart-ohlc-legend__item">
              거래량 <Typography as="strong" size={12}>{formatVolume(hoveredCandle.volume)}</Typography>
            </Typography>
          )}
        </div>
      )}
      <div ref={containerRef} className="candle-chart" />
      {barCountdown && (
        <Typography
          size={10}
          className="chart-countdown"
          style={{
            top: barCountdown.y,
            width: barCountdown.axisWidth,
            background: barCountdown.color,
          }}
          aria-label="봉 마감까지 남은 시간"
        >
          {barCountdown.text}
        </Typography>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LogicalRange,
  type UTCTimestamp,
} from 'lightweight-charts';
import { calculateBollingerBandSeries } from '../lib/bollingerBands';
import { BollingerBandFillPrimitive } from '../lib/bollingerBandFillPrimitive';
import { useTheme } from '../context/ThemeContext';
import {
  getStoredChartViewport,
  setStoredChartViewport,
  type ChartViewport,
} from '../lib/chartViewportPreference';
import { getChartThemeColors } from '../lib/chartTheme';
import type { ChartCandle } from '../types';

interface CandleChartProps {
  candles: ChartCandle[];
  averagePrice?: number;
  loading?: boolean;
  error?: string | null;
  fitKey?: string;
  hasMoreHistory?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
}

const HISTORY_LOAD_THRESHOLD = 15;
const CHART_MIN_HEIGHT = 200;

function getChartHeight(container: HTMLDivElement) {
  return Math.max(container.clientHeight, CHART_MIN_HEIGHT);
}
const CANDLE_PANE_STRETCH = 0.72;
const VOLUME_PANE_STRETCH = 0.28;
const PRICE_TOP_HEADROOM_RATIO = 0.01;
const BAR_SPACING_DRIFT_THRESHOLD = 0.001;
const RIGHT_OFFSET_DRIFT_THRESHOLD = 0.5;
const CHART_MIN_BAR_SPACING = 0.0001;
const RIGHT_MARGIN_FRACTION = 1 / 3;

interface HoveredCandleOhlc {
  open: number;
  high: number;
  low: number;
  close: number;
}

function formatChartPrice(value: number) {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function formatPercentFromOpen(value: number, open: number) {
  if (!Number.isFinite(open) || open === 0) return '';
  const percent = ((value - open) / open) * 100;
  const sign = percent > 0 ? '+' : '';
  return ` (${sign}${percent.toFixed(2)}%)`;
}

function formatOhlcLegendValue(value: number, open: number) {
  return `${formatChartPrice(value)}${formatPercentFromOpen(value, open)}`;
}

function getCandlePriceScaleOptions() {
  return {
    autoscaleInfoProvider: (
      original: () => { priceRange: { minValue: number; maxValue: number } | null } | null
    ) => {
      const res = original();
      if (!res?.priceRange) return res;

      const { minValue, maxValue } = res.priceRange;
      return {
        ...res,
        priceRange: {
          minValue,
          maxValue: maxValue * (1 + PRICE_TOP_HEADROOM_RATIO),
        },
      };
    },
    scaleMargins: {
      top: 0,
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

  const rightOffset = viewport.rightOffset ?? marginBars;
  return rightOffset <= marginBars * 1.5;
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

function applyChartViewportWhenReady(chart: IChartApi, viewport: ChartViewport, attempt = 0) {
  if (getTimeScaleWidth(chart) <= 0 && attempt < 8) {
    requestAnimationFrame(() => {
      applyChartViewportWhenReady(chart, viewport, attempt + 1);
    });
    return;
  }

  applyViewportSpacing(chart, viewport);
}

function applyInitialViewport(chart: IChartApi) {
  chart.timeScale().applyOptions({
    minBarSpacing: CHART_MIN_BAR_SPACING,
  });
  chart.timeScale().fitContent();

  const barSpacing = chart.timeScale().options().barSpacing;
  if (!barSpacing || barSpacing <= 0) return;

  chart.timeScale().applyOptions({
    minBarSpacing: CHART_MIN_BAR_SPACING,
    barSpacing,
    rightOffset: getMarginBars(chart, barSpacing),
  });
}

function getBollingerLineOptions(
  colors: ReturnType<typeof getChartThemeColors>,
  color: string,
  title: string,
  lineStyle: LineStyle
) {
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
      vertLines: { color: colors.grid },
      horzLines: { color: colors.grid },
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
    getBollingerLineOptions(colors, colors.bollingerUpper, 'BB 상단', LineStyle.Dashed)
  );
  bollingerSeries.middle?.applyOptions(
    getBollingerLineOptions(colors, colors.bollingerMiddle, 'BB 중간', LineStyle.Solid)
  );
  bollingerSeries.lower?.applyOptions(
    getBollingerLineOptions(colors, colors.bollingerLower, 'BB 하단', LineStyle.Dashed)
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
  hasMoreHistory = false,
  loadingOlder = false,
  onLoadOlder,
}: CandleChartProps) {
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const bbUpperSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbMiddleSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbLowerSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbFillPrimitiveRef = useRef<BollingerBandFillPrimitive | null>(null);
  const avgPriceLineRef = useRef<IPriceLine | null>(null);
  const prevFirstTimeRef = useRef<number | null>(null);
  const prevDataLengthRef = useRef<number | null>(null);
  const onLoadOlderRef = useRef(onLoadOlder);
  const hasMoreHistoryRef = useRef(hasMoreHistory);
  const loadingOlderRef = useRef(loadingOlder);
  const fitKeyRef = useRef(fitKey);
  const viewportInitializedRef = useRef(false);
  const pendingRestoreRef = useRef<ChartViewport | null>(null);
  const lastBarIndexRef = useRef(0);
  const chartWidthRef = useRef(0);
  const [hoveredCandle, setHoveredCandle] = useState<HoveredCandleOhlc | null>(null);

  onLoadOlderRef.current = onLoadOlder;
  hasMoreHistoryRef.current = hasMoreHistory;
  loadingOlderRef.current = loadingOlder;
  fitKeyRef.current = fitKey;

  useEffect(() => {
    pendingRestoreRef.current = fitKey ? getStoredChartViewport(fitKey) : null;
    viewportInitializedRef.current = false;
    prevDataLengthRef.current = null;
  }, [fitKey]);

  useEffect(() => {
    if (!containerRef.current) return;

    const colors = getChartThemeColors();

    chartWidthRef.current = containerRef.current.clientWidth;

    const chart = createChart(containerRef.current, {
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
        vertLines: { color: colors.grid },
        horzLines: { color: colors.grid },
      },
      rightPriceScale: {
        borderColor: colors.border,
      },
      timeScale: {
        borderColor: colors.border,
        timeVisible: true,
        secondsVisible: false,
        minBarSpacing: CHART_MIN_BAR_SPACING,
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
    });

    series.applyOptions(getCandlePriceScaleOptions());

    const bbUpperSeries = chart.addSeries(
      LineSeries,
      getBollingerLineOptions(colors, colors.bollingerUpper, 'BB 상단', LineStyle.Dashed),
      0
    );
    const bbMiddleSeries = chart.addSeries(
      LineSeries,
      getBollingerLineOptions(colors, colors.bollingerMiddle, 'BB 중간', LineStyle.Solid),
      0
    );
    const bbLowerSeries = chart.addSeries(
      LineSeries,
      getBollingerLineOptions(colors, colors.bollingerLower, 'BB 하단', LineStyle.Dashed),
      0
    );
    const bbFillPrimitive = new BollingerBandFillPrimitive();
    bbFillPrimitive.setFillColor(colors.bollingerFill);
    bbMiddleSeries.attachPrimitive(bbFillPrimitive);

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

    chartRef.current = chart;
    seriesRef.current = series;
    bbUpperSeriesRef.current = bbUpperSeries;
    bbMiddleSeriesRef.current = bbMiddleSeries;
    bbLowerSeriesRef.current = bbLowerSeries;
    bbFillPrimitiveRef.current = bbFillPrimitive;
    volumeSeriesRef.current = volumeSeries;

    const saveViewportIfReady = (targetChart: IChartApi = chart) => {
      if (!viewportInitializedRef.current) return;

      const currentFitKey = fitKeyRef.current;
      if (!currentFitKey) return;

      const viewport = captureChartViewport(targetChart, lastBarIndexRef.current);
      if (viewport) {
        setStoredChartViewport(currentFitKey, viewport);
      }
    };

    const handlePageHide = () => {
      saveViewportIfReady(chart);
    };

    window.addEventListener('pagehide', handlePageHide);

    const handleVisibleRangeChange = (range: LogicalRange | null) => {
      if (!range) return;
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
      setHoveredCandle({
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      });
    };

    chart.subscribeCrosshairMove(handleCrosshairMove);

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || !chartRef.current) return;
      chartWidthRef.current = entry.contentRect.width;
      chartRef.current.applyOptions({
        width: entry.contentRect.width,
        height: Math.max(entry.contentRect.height, CHART_MIN_HEIGHT),
      });
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
      seriesRef.current = null;
      bbUpperSeriesRef.current = null;
      bbMiddleSeriesRef.current = null;
      bbLowerSeriesRef.current = null;
      bbFillPrimitiveRef.current = null;
      volumeSeriesRef.current = null;
      avgPriceLineRef.current = null;
    };
  }, []);

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
  }, [theme]);

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
      lineWidth: 2 as const,
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

  useEffect(() => {
    if (!seriesRef.current || !volumeSeriesRef.current) return;

    const colors = getChartThemeColors();
    const sortedCandles = candles.slice().sort((a, b) => a.time - b.time);

    const data = sortedCandles.map((candle) => ({
      time: candle.time as UTCTimestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    }));

    const volumeData = sortedCandles.map((candle) => ({
      time: candle.time as UTCTimestamp,
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

    const bollingerBands = calculateBollingerBandSeries(sortedCandles);
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
    } else if (pendingRestoreRef.current) {
      const viewport = pendingRestoreRef.current;
      applyChartViewportWhenReady(chart, viewport);
      pendingRestoreRef.current = null;
      viewportInitializedRef.current = true;
    } else if (!viewportInitializedRef.current) {
      applyInitialViewport(chart);
      viewportInitializedRef.current = true;
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
        applyViewportSpacing(chart, liveViewport, { forceRealtimeMargin: true });
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
  }, [candles, fitKey]);

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
        <p className={`chart-status${error ? ' error-text' : ' hint'}`}>{chartStatus}</p>
      )}
      {hoveredCandle && (
        <div className="chart-ohlc-legend" aria-live="polite">
          <span className="chart-ohlc-legend__item">
            시가 <strong>{formatOhlcLegendValue(hoveredCandle.open, hoveredCandle.open)}</strong>
          </span>
          <span className="chart-ohlc-legend__item up">
            고가 <strong>{formatOhlcLegendValue(hoveredCandle.high, hoveredCandle.open)}</strong>
          </span>
          <span className="chart-ohlc-legend__item down">
            저가 <strong>{formatOhlcLegendValue(hoveredCandle.low, hoveredCandle.open)}</strong>
          </span>
          <span className={`chart-ohlc-legend__item${isUpCandle ? ' up' : ' down'}`}>
            종가 <strong>{formatOhlcLegendValue(hoveredCandle.close, hoveredCandle.open)}</strong>
          </span>
        </div>
      )}
      <div ref={containerRef} className="candle-chart" />
    </div>
  );
}

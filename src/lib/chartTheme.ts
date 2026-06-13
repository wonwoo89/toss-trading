export interface ChartThemeColors {
  background: string
  text: string
  grid: string
  border: string
  crosshair: string
  separator: string
  separatorHover: string
  candleUp: string
  candleDown: string
  avgPriceLine: string
  avgPriceLabelText: string
  bollingerUpper: string
  bollingerMiddle: string
  bollingerLower: string
  bollingerFill: string
}

function readCssVar(name: string, fallback: string) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

export function getChartThemeColors(): ChartThemeColors {
  return {
    background: readCssVar('--chart-bg', '#141414'),
    text: readCssVar('--chart-text', '#a0a0a0'),
    grid: readCssVar('--chart-grid', 'rgba(255, 255, 255, 0.06)'),
    border: readCssVar('--chart-border', 'rgba(255, 255, 255, 0.1)'),
    crosshair: readCssVar('--chart-crosshair', 'rgba(160, 160, 160, 0.5)'),
    separator: readCssVar('--chart-separator', 'rgba(255, 255, 255, 0.14)'),
    separatorHover: readCssVar('--chart-separator-hover', 'rgba(160, 160, 160, 0.3)'),
    candleUp: readCssVar('--color-up', '#e74c5e'),
    candleDown: readCssVar('--color-down', '#4a8fe7'),
    avgPriceLine: readCssVar('--chart-avg-price-line', '#d4a24a'),
    avgPriceLabelText: readCssVar('--chart-avg-price-label-text', '#171717'),
    bollingerUpper: readCssVar('--chart-bb-upper', '#f5d547'),
    bollingerMiddle: readCssVar('--chart-bb-middle', '#f5d547'),
    bollingerLower: readCssVar('--chart-bb-lower', '#f5d547'),
    bollingerFill: readCssVar('--chart-bb-fill', 'rgba(245, 213, 71, 0.08)'),
  }
}
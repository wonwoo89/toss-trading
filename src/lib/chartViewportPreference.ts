export interface ChartViewport {
  timeFrom: number
  timeTo: number
  logicalFrom: number
  logicalTo: number
  barSpacing?: number
  rightOffset?: number
  lastBarIndex?: number
}

const STORAGE_KEY = 'toss-trading:chart-viewport'
const MIN_VALID_TIMESTAMP = 1_000_000_000

function readStore(): Record<string, ChartViewport> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw) as Record<string, ChartViewport>
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed
  } catch {
    return {}
  }
}

function toNumber(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeViewport(raw: ChartViewport | undefined): ChartViewport | null {
  if (!raw) return null

  const timeFrom = toNumber(raw.timeFrom)
  const timeTo = toNumber(raw.timeTo)
  const logicalFrom = toNumber(raw.logicalFrom)
  const logicalTo = toNumber(raw.logicalTo)
  const barSpacing = raw.barSpacing === undefined ? undefined : toNumber(raw.barSpacing)
  const rightOffset = raw.rightOffset === undefined ? undefined : toNumber(raw.rightOffset)
  const lastBarIndex = raw.lastBarIndex === undefined ? undefined : toNumber(raw.lastBarIndex)

  if (
    timeFrom === null ||
    timeTo === null ||
    timeTo <= timeFrom ||
    timeFrom < MIN_VALID_TIMESTAMP ||
    logicalFrom === null ||
    logicalTo === null ||
    logicalTo <= logicalFrom
  ) {
    return null
  }

  if (barSpacing !== undefined && barSpacing <= 0) return null
  if (rightOffset !== undefined && rightOffset < 0) return null
  if (lastBarIndex !== undefined && lastBarIndex < 0) return null

  return {
    timeFrom,
    timeTo,
    logicalFrom,
    logicalTo,
    barSpacing: barSpacing ?? undefined,
    rightOffset: rightOffset ?? undefined,
    lastBarIndex: lastBarIndex ?? undefined,
  }
}

export function getStoredChartViewport(fitKey: string): ChartViewport | null {
  return normalizeViewport(readStore()[fitKey])
}

export function setStoredChartViewport(fitKey: string, viewport: ChartViewport) {
  const normalized = normalizeViewport(viewport)
  if (!normalized) return

  try {
    const store = readStore()
    store[fitKey] = normalized
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // ignore storage write errors
  }
}
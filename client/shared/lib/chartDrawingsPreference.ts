import type { DrawingStroke } from './chartDrawingPrimitive';

/** 펜슬 드로잉 종목별 영속화 (localStorage). */

const KEY_PREFIX = 'toss-trading:chart-drawings:';
const MAX_STROKES = 60;
const MAX_POINTS_PER_STROKE = 400;

export function getChartDrawings(symbol: string): DrawingStroke[] {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + symbol.toUpperCase());
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (s): s is DrawingStroke =>
          !!s && (s.kind === 'free' || s.kind === 'hline') && Array.isArray(s.points)
      )
      .slice(0, MAX_STROKES);
  } catch {
    return [];
  }
}

export function saveChartDrawings(symbol: string, strokes: DrawingStroke[]) {
  try {
    const compact = strokes.slice(-MAX_STROKES).map((s) => ({
      ...s,
      points: s.points.slice(0, MAX_POINTS_PER_STROKE),
    }));
    localStorage.setItem(KEY_PREFIX + symbol.toUpperCase(), JSON.stringify(compact));
  } catch {
    // 저장 실패 무시(용량 초과 등) — 세션 내 상태로만 동작
  }
}

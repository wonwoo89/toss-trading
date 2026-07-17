import type { AiDecisionCandle } from './ai-decision.js';

/**
 * 서버 자동매매 엔진용 경량 지표 계산 — 클라이언트가 AI 요청에 실어 보내는 signal/trend 를
 * 서버가 스스로 만들어 동등한 판단 컨텍스트를 제공한다. WASM 백엔드 의존 없이 순수 JS로
 * RSI/SMA/ATR 과 단순 추세만 계산한다(백그라운드 배치라 정밀도보다 견고함을 우선).
 */

function round(value: number | undefined, digits = 4): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function sma(values: number[], period: number): number | undefined {
  if (values.length < period) return undefined;
  const slice = values.slice(-period);
  return slice.reduce((sum, v) => sum + v, 0) / period;
}

function rsi(closes: number[], period = 14): number | undefined {
  if (closes.length < period + 1) return undefined;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function atr(candles: AiDecisionCandle[], period = 14): number | undefined {
  if (candles.length < period + 1) return undefined;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const c = candles[i];
    const p = candles[i - 1];
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  const slice = trs.slice(-period);
  return slice.reduce((sum, v) => sum + v, 0) / slice.length;
}

export interface ComputedSignal {
  level: string;
  score: number;
  rsi?: number;
  sma20?: number;
  sma50?: number;
  atr?: number;
}

/** RSI/이동평균 배열을 종합해 강세/중립/약세 신호를 산출. */
export function computeSignal(candles: AiDecisionCandle[]): ComputedSignal {
  const closes = candles.map((c) => c.c);
  const r = rsi(closes);
  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  const a = atr(candles);
  const price = closes[closes.length - 1];

  let score = 0;
  if (r !== undefined) {
    if (r < 30) score += 1;
    else if (r > 70) score -= 1;
  }
  if (s20 !== undefined && s50 !== undefined) score += s20 > s50 ? 1 : -1;
  if (s20 !== undefined && price !== undefined) score += price > s20 ? 0.5 : -0.5;

  const level = score >= 1.5 ? '강세' : score <= -1.5 ? '약세' : '중립';
  return {
    level,
    score: round(score, 2) ?? 0,
    rsi: round(r, 2),
    sma20: round(s20),
    sma50: round(s50),
    atr: round(a),
  };
}

export interface ComputedTrend {
  state: string;
  confirmedBars: number;
}

/** 종가 방향이 연속으로 유지된 봉 수 → 단순 추세 상태(up/down/flat). */
export function computeTrend(candles: AiDecisionCandle[]): ComputedTrend {
  if (candles.length < 2) return { state: 'unknown', confirmedBars: 0 };
  const closes = candles.map((c) => c.c);
  const lastDir = Math.sign(closes[closes.length - 1] - closes[closes.length - 2]);
  if (lastDir === 0) return { state: 'flat', confirmedBars: 0 };

  let bars = 0;
  for (let i = closes.length - 1; i > 0; i -= 1) {
    const dir = Math.sign(closes[i] - closes[i - 1]);
    if (dir === lastDir) bars += 1;
    else break;
  }
  return { state: lastDir > 0 ? 'up' : 'down', confirmedBars: bars };
}

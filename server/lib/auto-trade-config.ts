import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 서버 자동매매 엔진 설정 저장소 (JSON 파일 영속).
 *
 * 개인용 단일 계좌 전제라 DB 없이 파일 하나로 관리한다. 종목별 설정 + 전역 킬스위치.
 * 실제 매매 실행(워커)은 후속 단계에서 이 설정을 읽어 동작한다. (1단계: 저장/조회만)
 *
 * 안전 상한(사용자 확정):
 *  - 최대 5종목
 *  - 1회 매수 = 주문가능금액의 최대 5%
 *  - 일일 손실 한도 = 전 종목 실현손익 합산 기준
 *  - 전역 킬스위치(enabled) 하나로 전 종목 즉시 정지
 */

export const MAX_AUTO_SYMBOLS = 5;
export const MAX_BUY_PERCENT_CAP = 5; // 1회 매수 상한(%) — 이 값을 넘길 수 없다.
/** 서버 엔진 봉 주기는 5분봉 고정. */
export const AUTO_CANDLE_INTERVAL = '5m' as const;

export interface AutoSymbolConfig {
  symbol: string;
  /** 이 종목 자동매매 활성 여부(전역 enabled 와 AND). */
  active: boolean;
  /** 목표 수익률(%) — 익절. */
  targetPercent: number;
  /** 손절률(%). */
  stopLossPercent: number;
  /** 트레일링 스탑(%). 0=끔. */
  trailingStopPercent: number;
  /** 1회 매수 = 주문가능금액의 이 비율(%). 0<..<=5 로 클램프. */
  buyMaxPercent: number;
}

export interface AutoTradeConfig {
  /** 전역 킬스위치 — false 면 전 종목 정지(개별 active 무시). */
  enabled: boolean;
  /** 일일 실현 손실 한도(USD, 전 종목 합산). 0=끔. 초과 시 엔진이 전역 정지. */
  dailyLossLimitUsd: number;
  symbols: AutoSymbolConfig[];
}

export const AUTO_TRADE_DEFAULT: AutoTradeConfig = {
  enabled: false,
  dailyLossLimitUsd: 0,
  symbols: [],
};

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATA_DIR = path.join(rootDir, 'server', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'auto-trade-config.json');

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitizeSymbolConfig(raw: unknown): AutoSymbolConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const symbol = typeof r.symbol === 'string' ? r.symbol.trim().toUpperCase() : '';
  if (!symbol) return null;
  return {
    symbol,
    active: r.active === true,
    targetPercent: clampNumber(r.targetPercent, 0.1, 100, 3),
    stopLossPercent: clampNumber(r.stopLossPercent, 0.1, 100, 2),
    trailingStopPercent: clampNumber(r.trailingStopPercent, 0, 100, 0),
    // 1회 매수는 서버 상한(5%)을 절대 넘길 수 없다.
    buyMaxPercent: clampNumber(r.buyMaxPercent, 0.1, MAX_BUY_PERCENT_CAP, MAX_BUY_PERCENT_CAP),
  };
}

/** 저장/입력값을 안전 범위·상한으로 정규화. 종목 중복 제거 + 최대 5종목으로 자른다. */
export function sanitizeConfig(raw: unknown): AutoTradeConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const seen = new Set<string>();
  const symbols: AutoSymbolConfig[] = [];
  if (Array.isArray(r.symbols)) {
    for (const item of r.symbols) {
      const sc = sanitizeSymbolConfig(item);
      if (!sc || seen.has(sc.symbol)) continue;
      seen.add(sc.symbol);
      symbols.push(sc);
      if (symbols.length >= MAX_AUTO_SYMBOLS) break;
    }
  }
  return {
    enabled: r.enabled === true,
    dailyLossLimitUsd: clampNumber(r.dailyLossLimitUsd, 0, 1_000_000, 0),
    symbols,
  };
}

let cache: AutoTradeConfig | null = null;

export function getAutoTradeConfig(): AutoTradeConfig {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    cache = sanitizeConfig(JSON.parse(raw));
  } catch {
    cache = { ...AUTO_TRADE_DEFAULT };
  }
  return cache;
}

export function saveAutoTradeConfig(raw: unknown): AutoTradeConfig {
  const next = sanitizeConfig(raw);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  } catch (error) {
    // 파일 쓰기 실패는 로깅만 — 캐시는 갱신해 세션 내 동작은 유지.
    console.error('[auto-trade] 설정 저장 실패:', error);
  }
  cache = next;
  return next;
}

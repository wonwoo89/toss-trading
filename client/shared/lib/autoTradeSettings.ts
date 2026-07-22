/**
 * 자동매매 설정·상태 영속화 (localStorage).
 *  - 설정: 모드·AI 사용·목표/손절/트레일링 %·1회 매수 비중·일일 손실 한도.
 *    새로고침/재접속 후에도 유지돼 모바일 PWA 재시작 시 다시 켤 필요가 없다.
 *  - 일일 실현 손익 원장: 자동매매 실주문 매도의 실현 손익을 날짜별로 누적,
 *    일일 손실 한도(초과 시 자동 OFF) 판정에 사용.
 *  - 판단/실행 로그: 최근 항목을 영속해 새로고침 후에도 감사 기록이 남는다.
 */

export type AutoTradeMode = 'off' | 'dryrun' | 'auto';

export interface AutoTradeSettings {
  mode: AutoTradeMode;
  /** AI 매매 모드가 켜져 있던 종목 — 다른 종목으로 이동 시 자동 OFF 판정에 사용. */
  activeSymbol?: string;
  useAi: boolean;
  targetPercent: number;
  stopLossPercent: number;
  /** 고점 대비 하락 % 트레일링 스탑. 0 이면 비활성. */
  trailingStopPercent: number;
  /** 1회 매수 금액 상한 = 주문가능금액의 이 비율(%). */
  buyMaxPercent: number;
  /** 일일 실현 손실 한도(USD). 초과 시 자동매매 강제 OFF. 0 이면 비활성. */
  dailyLossLimitUsd: number;
  /** 목표 도달 시 상승 추세면 익절을 보류하고 고점 추적(보전선 이탈 시 매도). */
  holdTpOnTrend: boolean;
  /** 변동성(ATR) 기반 동적 목표/손절(AI 매매 서버 옵션). */
  useAtrLevels: boolean;
}

export const AUTO_TRADE_DEFAULTS: AutoTradeSettings = {
  mode: 'off',
  useAi: true,
  targetPercent: 1,
  stopLossPercent: 3,
  trailingStopPercent: 0,
  buyMaxPercent: 5,
  dailyLossLimitUsd: 0,
  holdTpOnTrend: true,
  useAtrLevels: false,
};

/**
 * 기본값 개정 버전. 저장본의 버전이 낮으면 목표/손절만 새 기본값으로 1회 덮어쓴다
 * (사용자 요청으로 기본값을 바꿀 때 기기에 남은 옛 저장값이 이기지 않도록).
 *  - v2: 목표 3→1%, 손절 2→3%
 */
const SETTINGS_DEFAULTS_VERSION = 2;

const SETTINGS_KEY = 'toss-trading:auto-trade-settings';
const LEDGER_KEY = 'toss-trading:auto-trade-daily-pnl';
const LOG_KEY = 'toss-trading:auto-trade-log';
const MAX_PERSISTED_LOG = 40;

function isMode(value: unknown): value is AutoTradeMode {
  // 구버전 저장값 'semi'(세미오토, 제거됨)는 무효 처리 → 기본값 off 로 복원된다.
  return value === 'off' || value === 'dryrun' || value === 'auto';
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function getAutoTradeSettings(): AutoTradeSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return AUTO_TRADE_DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<AutoTradeSettings> & { defaultsVersion?: number };
    // 구버전 저장본: 목표/손절만 새 기본값으로 1회 마이그레이션(나머지 설정은 유지).
    const outdated = numberOr(parsed.defaultsVersion, 0) < SETTINGS_DEFAULTS_VERSION;
    return {
      mode: isMode(parsed.mode) ? parsed.mode : AUTO_TRADE_DEFAULTS.mode,
      activeSymbol: typeof parsed.activeSymbol === 'string' ? parsed.activeSymbol : undefined,
      useAi: typeof parsed.useAi === 'boolean' ? parsed.useAi : AUTO_TRADE_DEFAULTS.useAi,
      targetPercent: outdated
        ? AUTO_TRADE_DEFAULTS.targetPercent
        : numberOr(parsed.targetPercent, AUTO_TRADE_DEFAULTS.targetPercent),
      stopLossPercent: outdated
        ? AUTO_TRADE_DEFAULTS.stopLossPercent
        : numberOr(parsed.stopLossPercent, AUTO_TRADE_DEFAULTS.stopLossPercent),
      trailingStopPercent: numberOr(
        parsed.trailingStopPercent,
        AUTO_TRADE_DEFAULTS.trailingStopPercent
      ),
      buyMaxPercent: numberOr(parsed.buyMaxPercent, AUTO_TRADE_DEFAULTS.buyMaxPercent),
      dailyLossLimitUsd: numberOr(
        parsed.dailyLossLimitUsd,
        AUTO_TRADE_DEFAULTS.dailyLossLimitUsd
      ),
      holdTpOnTrend:
        typeof parsed.holdTpOnTrend === 'boolean'
          ? parsed.holdTpOnTrend
          : AUTO_TRADE_DEFAULTS.holdTpOnTrend,
      useAtrLevels:
        typeof parsed.useAtrLevels === 'boolean'
          ? parsed.useAtrLevels
          : AUTO_TRADE_DEFAULTS.useAtrLevels,
    };
  } catch {
    return AUTO_TRADE_DEFAULTS;
  }
}

export function saveAutoTradeSettings(settings: AutoTradeSettings): void {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ ...settings, defaultsVersion: SETTINGS_DEFAULTS_VERSION })
    );
  } catch {
    // 저장 실패는 무시(프라이빗 모드 등) — 세션 내 상태로만 동작
  }
}

// ── 일일 실현 손익 원장 ─────────────────────────────────────────

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 오늘의 자동매매 실현 손익(USD). 이익이면 양수, 손실이면 음수. */
export function getDailyRealizedUsd(): number {
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { date?: string; realizedUsd?: number };
    if (parsed.date !== todayKey()) return 0; // 날짜가 바뀌면 리셋
    return numberOr(parsed.realizedUsd, 0);
  } catch {
    return 0;
  }
}

/** 자동매매 실주문 매도의 실현 손익을 오늘 원장에 누적하고 누계를 반환. */
export function addDailyRealizedUsd(delta: number): number {
  const next = getDailyRealizedUsd() + (Number.isFinite(delta) ? delta : 0);
  try {
    localStorage.setItem(LEDGER_KEY, JSON.stringify({ date: todayKey(), realizedUsd: next }));
  } catch {
    // 저장 실패 무시
  }
  return next;
}

// ── 자동매매 로그 영속화 ────────────────────────────────────────

export interface PersistedAutoTradeLog {
  id: string;
  time: string;
  level: 'trigger' | 'exec' | 'skip' | 'block';
  side: 'BUY' | 'SELL';
  symbol: string;
  text: string;
}

export function loadAutoTradeLogs(): PersistedAutoTradeLog[] {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed.slice(0, MAX_PERSISTED_LOG) as PersistedAutoTradeLog[]) : [];
  } catch {
    return [];
  }
}

export function saveAutoTradeLogs(logs: PersistedAutoTradeLog[]): void {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(logs.slice(0, MAX_PERSISTED_LOG)));
  } catch {
    // 저장 실패 무시
  }
}

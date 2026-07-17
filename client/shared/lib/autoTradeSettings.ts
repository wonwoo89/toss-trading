/**
 * 자동매매 설정·상태 영속화 (localStorage).
 *  - 설정: 모드·AI 사용·목표/손절/트레일링 %·1회 매수 비중·일일 손실 한도.
 *    새로고침/재접속 후에도 유지돼 모바일 PWA 재시작 시 다시 켤 필요가 없다.
 *  - 일일 실현 손익 원장: 자동매매 실주문 매도의 실현 손익을 날짜별로 누적,
 *    일일 손실 한도(초과 시 자동 OFF) 판정에 사용.
 *  - 판단/실행 로그: 최근 항목을 영속해 새로고침 후에도 감사 기록이 남는다.
 */

export type AutoTradeMode = 'off' | 'dryrun' | 'semi' | 'auto';

export interface AutoTradeSettings {
  mode: AutoTradeMode;
  /** 세미/오토 모드가 켜져 있던 종목 — 다른 종목으로 이동 시 자동 OFF 판정에 사용. */
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
}

export const AUTO_TRADE_DEFAULTS: AutoTradeSettings = {
  mode: 'off',
  useAi: true,
  targetPercent: 3,
  stopLossPercent: 2,
  trailingStopPercent: 0,
  buyMaxPercent: 5,
  dailyLossLimitUsd: 0,
};

const SETTINGS_KEY = 'toss-trading:auto-trade-settings';
const LEDGER_KEY = 'toss-trading:auto-trade-daily-pnl';
const LOG_KEY = 'toss-trading:auto-trade-log';
const MAX_PERSISTED_LOG = 40;

function isMode(value: unknown): value is AutoTradeMode {
  return value === 'off' || value === 'dryrun' || value === 'semi' || value === 'auto';
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function getAutoTradeSettings(): AutoTradeSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return AUTO_TRADE_DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<AutoTradeSettings>;
    return {
      mode: isMode(parsed.mode) ? parsed.mode : AUTO_TRADE_DEFAULTS.mode,
      activeSymbol: typeof parsed.activeSymbol === 'string' ? parsed.activeSymbol : undefined,
      useAi: typeof parsed.useAi === 'boolean' ? parsed.useAi : AUTO_TRADE_DEFAULTS.useAi,
      targetPercent: numberOr(parsed.targetPercent, AUTO_TRADE_DEFAULTS.targetPercent),
      stopLossPercent: numberOr(parsed.stopLossPercent, AUTO_TRADE_DEFAULTS.stopLossPercent),
      trailingStopPercent: numberOr(
        parsed.trailingStopPercent,
        AUTO_TRADE_DEFAULTS.trailingStopPercent
      ),
      buyMaxPercent: numberOr(parsed.buyMaxPercent, AUTO_TRADE_DEFAULTS.buyMaxPercent),
      dailyLossLimitUsd: numberOr(
        parsed.dailyLossLimitUsd,
        AUTO_TRADE_DEFAULTS.dailyLossLimitUsd
      ),
    };
  } catch {
    return AUTO_TRADE_DEFAULTS;
  }
}

export function saveAutoTradeSettings(settings: AutoTradeSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
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

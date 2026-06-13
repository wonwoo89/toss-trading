import type { UsMarketDayRaw } from '../types';

export type UsMarketSessionKind =
  | 'day'
  | 'pre'
  | 'regular'
  | 'after'
  | 'closed'
  | 'holiday'
  | 'unknown';

export interface UsMarketSessionWindow {
  startTime: Date;
  endTime: Date;
}

export interface UsMarketSessionStatus {
  kind: UsMarketSessionKind;
  label: string;
  detail?: string;
  countdown?: string;
  holiday?: boolean;
  unavailable?: boolean;
}

const SESSION_DEFS = [
  { kind: 'day' as const, label: '데이마켓', key: 'dayMarket' as const },
  { kind: 'pre' as const, label: '프리마켓', key: 'preMarket' as const },
  { kind: 'regular' as const, label: '정규장', key: 'regularMarket' as const },
  { kind: 'after' as const, label: '애프터마켓', key: 'afterMarket' as const },
];

function parseSession(
  session?: { startTime: string; endTime: string } | null
): UsMarketSessionWindow | null {
  if (!session?.startTime || !session?.endTime) return null;

  const startTime = new Date(session.startTime);
  const endTime = new Date(session.endTime);
  if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) return null;

  return { startTime, endTime };
}

function formatKstTime(date: Date) {
  return date.toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Seoul',
  });
}

export function formatCountdown(remainingMs: number) {
  if (remainingMs <= 0) return undefined;

  const totalSeconds = Math.ceil(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function isUsWeekend(date = new Date()): boolean {
  // 미국 장 기준 (Eastern Time)으로 주말 여부 판단
  const etDate = new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = etDate.getDay();
  return day === 0 || day === 6; // 0=일요일, 6=토요일
}

export function isUsMarketHoliday(today: UsMarketDayRaw | undefined): boolean {
  if (!today) return false;
  const status = resolveUsMarketSession(today);
  return status.holiday === true || status.kind === 'holiday';
}

export function shouldEnableRecurringMarketPolling(today: UsMarketDayRaw | undefined): boolean {
  if (isUsWeekend()) {
    // 주말이면 calendar 로드 전까지는 초기 요청을 허용하고,
    // holiday 정보가 오면 폴링 중단
    return !today || !isUsMarketHoliday(today);
  }
  return !isUsMarketHoliday(today);
}

export function resolveUsMarketSession(
  today: UsMarketDayRaw | undefined,
  now = new Date()
): UsMarketSessionStatus {
  if (!today) {
    return { kind: 'unknown', label: '장 정보 없음', unavailable: true };
  }

  const sessions = SESSION_DEFS.map((def) => ({
    ...def,
    window: parseSession(today[def.key]),
  }));

  if (sessions.every((session) => !session.window)) {
    return {
      kind: 'holiday',
      label: '휴장',
      detail: `${today.date} 미국 휴장`,
      holiday: true,
    };
  }

  const nowMs = now.getTime();

  for (const session of sessions) {
    if (!session.window) continue;

    const { startTime, endTime } = session.window;
    if (nowMs >= startTime.getTime() && nowMs < endTime.getTime()) {
      const remaining = endTime.getTime() - nowMs;
      return {
        kind: session.kind,
        label: session.label,
        detail: `종료 ${formatKstTime(endTime)} KST`,
        countdown: formatCountdown(remaining),
      };
    }
  }

  const upcoming = sessions
    .filter((session) => session.window && session.window.startTime.getTime() > nowMs)
    .sort((a, b) => a.window!.startTime.getTime() - b.window!.startTime.getTime())[0];

  if (upcoming?.window) {
    const remaining = upcoming.window.startTime.getTime() - nowMs;
    return {
      kind: 'closed',
      label: '장 마감',
      detail: `${upcoming.label} ${formatKstTime(upcoming.window.startTime)} KST`,
      countdown: formatCountdown(remaining),
    };
  }

  return { kind: 'closed', label: '장 마감', detail: '오늘 거래 종료' };
}

import type { UsMarketCalendarRaw, UsMarketDayRaw } from '../types';

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

function dayHasAnySession(day: UsMarketDayRaw | undefined): boolean {
  if (!day) return false;
  return SESSION_DEFS.some((def) => parseSession(day[def.key]) !== null);
}

export function isUsMarketHoliday(today: UsMarketDayRaw | undefined): boolean {
  if (!today) return false;
  // 세션 창이 하나도 없으면 휴장.
  return !dayHasAnySession(today);
}

export function shouldEnableRecurringMarketPolling(today: UsMarketDayRaw | undefined): boolean {
  if (isUsWeekend()) {
    // 주말이면 calendar 로드 전까지는 초기 요청을 허용하고,
    // holiday 정보가 오면 폴링 중단
    return !today || !isUsMarketHoliday(today);
  }
  return !isUsMarketHoliday(today);
}

interface ResolvedSession {
  kind: UsMarketSessionKind;
  label: string;
  window: UsMarketSessionWindow;
}

// 토스 캘린더는 세션을 KST 날짜 기준으로 버킷팅한다. 정규장은 전날(KST) 22:30 에 열려 자정을 넘겨
// 다음날 05:00 까지 이어지므로, 자정~새벽에는 활성 세션이 previousBusinessDay 에 들어 있다.
// 따라서 전날·오늘·다음날 세션을 모두 모아 현재 활성/다음 세션을 찾아야 한다.
function collectSessions(days: (UsMarketDayRaw | undefined)[]): ResolvedSession[] {
  const sessions: ResolvedSession[] = [];
  for (const day of days) {
    if (!day) continue;
    for (const def of SESSION_DEFS) {
      const window = parseSession(day[def.key]);
      if (window) {
        sessions.push({ kind: def.kind, label: def.label, window });
      }
    }
  }
  return sessions;
}

export function resolveUsMarketSession(
  calendar: UsMarketCalendarRaw | null | undefined,
  now = new Date()
): UsMarketSessionStatus {
  const today = calendar?.today;
  if (!today) {
    return { kind: 'unknown', label: '장 정보 없음', unavailable: true };
  }

  const nowMs = now.getTime();
  const sessions = collectSessions([
    calendar.previousBusinessDay,
    today,
    calendar.nextBusinessDay,
  ]);

  // 1) 현재 진행 중인 세션 (전날 정규장이 자정을 넘긴 경우 포함)
  for (const session of sessions) {
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

  // 2) 진행 중인 세션이 없고 오늘 세션 자체가 없으면 휴장
  if (!dayHasAnySession(today)) {
    return {
      kind: 'holiday',
      label: '휴장',
      detail: `${today.date} 미국 휴장`,
      holiday: true,
    };
  }

  // 3) 다음 개장까지 카운트다운
  const upcoming = sessions
    .filter((session) => session.window.startTime.getTime() > nowMs)
    .sort((a, b) => a.window.startTime.getTime() - b.window.startTime.getTime())[0];

  if (upcoming) {
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

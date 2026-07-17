import { tossRequest } from './toss-client.js';

/**
 * 서버용 미국장 세션 판정 — 백그라운드 자동매매 엔진이 "지금 장이 열렸는지"를 판단할 때 쓴다.
 * 클라이언트(client/shared/lib/usMarketCalendar.ts)의 축약판: 카운트다운/라벨 없이
 * 현재 활성 세션 종류만 돌려준다. 캘린더는 자주 변하지 않으므로 30분 캐시.
 */

export type UsMarketSessionKind =
  | 'day'
  | 'pre'
  | 'regular'
  | 'after'
  | 'closed'
  | 'holiday'
  | 'unknown';

interface SessionRaw {
  startTime: string;
  endTime: string;
}

interface DayRaw {
  date?: string;
  dayMarket?: SessionRaw | null;
  preMarket?: SessionRaw | null;
  regularMarket?: SessionRaw | null;
  afterMarket?: SessionRaw | null;
}

interface CalendarRaw {
  today?: DayRaw;
  previousBusinessDay?: DayRaw;
  nextBusinessDay?: DayRaw;
}

const SESSION_DEFS = [
  { kind: 'day' as const, key: 'dayMarket' as const },
  { kind: 'pre' as const, key: 'preMarket' as const },
  { kind: 'regular' as const, key: 'regularMarket' as const },
  { kind: 'after' as const, key: 'afterMarket' as const },
];

const CALENDAR_TTL_MS = 30 * 60 * 1000;
let cache: { calendar: CalendarRaw; fetchedAt: number } | null = null;

async function getCalendar(): Promise<CalendarRaw | null> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CALENDAR_TTL_MS) return cache.calendar;
  try {
    const res = await tossRequest<{ result: CalendarRaw }>({ path: '/api/v1/market-calendar/US' });
    cache = { calendar: res.result, fetchedAt: now };
    return res.result;
  } catch {
    // 조회 실패 시 마지막 캐시로 폴백(없으면 null → 'unknown').
    return cache?.calendar ?? null;
  }
}

function dayHasAnySession(day: DayRaw | undefined): boolean {
  if (!day) return false;
  return SESSION_DEFS.some((def) => {
    const s = day[def.key];
    return Boolean(s?.startTime && s?.endTime);
  });
}

/**
 * 현재 진행 중인 미국장 세션 종류를 판정. 정규장이 KST 자정을 넘겨 이어지므로
 * 전날·오늘·다음날 세션을 모두 훑어 현재 시각이 속한 세션을 찾는다.
 */
export async function getUsMarketSession(now = Date.now()): Promise<UsMarketSessionKind> {
  const calendar = await getCalendar();
  if (!calendar?.today) return 'unknown';

  const days = [calendar.previousBusinessDay, calendar.today, calendar.nextBusinessDay];
  for (const day of days) {
    if (!day) continue;
    for (const def of SESSION_DEFS) {
      const s = day[def.key];
      if (!s?.startTime || !s?.endTime) continue;
      const start = new Date(s.startTime).getTime();
      const end = new Date(s.endTime).getTime();
      if (Number.isFinite(start) && Number.isFinite(end) && now >= start && now < end) {
        return def.kind;
      }
    }
  }

  // 진행 중인 세션이 없다 — 오늘 세션 자체가 없으면 휴장, 있으면 장 마감(개장 전/후).
  return dayHasAnySession(calendar.today) ? 'closed' : 'holiday';
}

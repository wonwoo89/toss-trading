/**
 * 주문 이벤트 버스 — 서버(단일종목·백그라운드 엔진)가 낸 주문의 접수/취소/체결을
 * 메모리 링버퍼에 쌓고, 클라이언트가 폴링(/api/notifications)으로 가져가 토스트로 띄운다.
 * 재시작 시 초기화(과거 이벤트 재알림 없음) — 알림 용도라 영속이 필요 없다.
 */

export type OrderEventKind = 'order' | 'cancel' | 'fill';

export interface OrderEvent {
  id: number;
  t: number;
  /** single = 단일종목 트레이더, multi = 백그라운드 다종목 엔진 */
  source: 'single' | 'multi';
  kind: OrderEventKind;
  side: 'BUY' | 'SELL';
  symbol: string;
  /** 토스트에 그대로 띄울 완성 문구. */
  text: string;
}

const MAX_EVENTS = 100;
let seq = 0;
const events: OrderEvent[] = [];

export function pushOrderEvent(event: Omit<OrderEvent, 'id' | 't'>): void {
  seq += 1;
  events.push({ ...event, id: seq, t: Date.now() });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

/** after 이후의 이벤트 + 최신 커서. after=0(첫 폴링)은 커서만 받고 과거는 재생하지 않는다. */
export function getOrderEvents(after: number): { latest: number; events: OrderEvent[] } {
  if (after <= 0) return { latest: seq, events: [] };
  return { latest: seq, events: events.filter((e) => e.id > after) };
}

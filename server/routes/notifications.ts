import { Router } from 'express';
import { getOrderEvents, subscribeOrderEvents } from '../lib/order-events.js';

export const notificationsRouter = Router();

/** 주문 알림 폴링(폴백) — ?after=<마지막으로 받은 이벤트 id>. 0이면 커서만 초기화. */
notificationsRouter.get('/', (req, res) => {
  const after = Number(req.query.after ?? 0);
  res.json({ result: getOrderEvents(Number.isFinite(after) ? after : 0) });
});

/**
 * 주문 알림 실시간 스트림(SSE) — 접수/취소/체결을 발생 즉시 푸시한다.
 * - 이벤트마다 id 를 실어 보내므로, 끊겼다 재접속하면 브라우저(EventSource)가
 *   Last-Event-ID 를 자동 전송 → 놓친 이벤트를 링버퍼에서 리플레이한다.
 * - 25초 주기 주석 핑으로 프록시/유휴 타임아웃을 방지한다.
 */
notificationsRouter.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // nginx 계열 프록시 버퍼링 방지
  });
  res.write(': connected\n\n');

  const send = (event: { id: number }) => {
    res.write(`id: ${event.id}\nevent: order\ndata: ${JSON.stringify(event)}\n\n`);
  };

  // 재접속 리플레이 — 마지막 수신 id 이후 이벤트를 먼저 보낸다(첫 접속은 재생 없음).
  const lastId = Number(req.header('last-event-id') ?? 0);
  if (Number.isFinite(lastId) && lastId > 0) {
    for (const event of getOrderEvents(lastId).events) send(event);
  }

  const unsubscribe = subscribeOrderEvents(send);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
});

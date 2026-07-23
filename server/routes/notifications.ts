import { Router } from 'express';
import { getOrderEvents } from '../lib/order-events.js';

export const notificationsRouter = Router();

/** 주문 알림 폴링 — ?after=<마지막으로 받은 이벤트 id>. 0이면 커서만 초기화. */
notificationsRouter.get('/', (req, res) => {
  const after = Number(req.query.after ?? 0);
  res.json({ result: getOrderEvents(Number.isFinite(after) ? after : 0) });
});

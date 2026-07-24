import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../shared/api/client';
import { unwrapResult } from '../shared/lib/parse';
import { mapOrders } from '../shared/lib/mapPortfolio';
import { formatOrderDateLabel, formatOrderPriceLabel } from '../shared/lib/formatOrders';
import { useAppContext } from '../app/providers/AppContext';
import { resolveUsCommissionRatePercent } from '../shared/lib/commissionBreakEven';
import { Chip } from '../shared/ui/Chip';
import { Button } from '../shared/ui/Button';
import { Typography } from '../shared/ui/Typography';
import type { Order } from '../shared/types';

/** 기간 프리셋 — 주문 생성 시각(orderedAt, KST) 기준. */
const RANGE_OPTIONS = [
  { label: '오늘', days: 0 },
  { label: '1주', days: 7 },
  { label: '1개월', days: 30 },
  { label: '3개월', days: 90 },
] as const;

const PAGE_LIMIT = 50;

/** KST 기준 YYYY-MM-DD (offsetDays 일 전). */
function kstDateStr(offsetDays: number): string {
  return new Date(Date.now() + 9 * 3600 * 1000 - offsetDays * 86400 * 1000)
    .toISOString()
    .slice(0, 10);
}

const STATUS_LABELS: Record<string, string> = {
  FILLED: '체결',
  PARTIALLY_FILLED: '부분 체결',
  CANCELLED: '취소',
  CANCELED: '취소',
  EXPIRED: '만료',
  REJECTED: '거부',
  OPEN: '대기',
};

function statusLabel(order: Order): string {
  return STATUS_LABELS[order.status] ?? order.status;
}

function quantityLabel(order: Order): string {
  const filled = order.filledQuantity;
  const qty = order.quantity;
  if (filled !== undefined && qty !== undefined && filled !== qty) return `${filled}/${qty}주`;
  const n = qty ?? filled;
  return n === undefined ? '—' : `${n}주`;
}

/**
 * 누적 주문내역 모달 — 토스 /api/v1/orders 의 status=CLOSED(종료된 주문)를
 * 기간 프리셋 + 커서 페이지네이션으로 조회한다. (미체결은 기존 패널이 담당)
 */
interface DailyPnlRow {
  symbol: string;
  realized: number;
  soldQty: number;
}

interface HoldingSnapshot {
  quantity: number;
  averagePrice: number;
}

const QTY_EPS = 1e-6;

/** 오늘 실현 손익 — 평균단가법을 그대로 재현한다(토스와 동일 방식).
 *  1) 현재 보유(수량·평단)에서 오늘 체결을 역순으로 되감아 장 시작 시점 평단을 복원하고
 *  2) 시간순으로 재생하며 각 매도 시점의 평단으로 (체결가 − 평단) × 수량 − 왕복 수수료를 누적.
 *  이월 포지션을 오늘 전량 청산해 평단을 복원할 수 없는 종목만 제외로 명시한다. */
function computeDailyPnl(
  orders: Order[],
  holdings: Record<string, HoldingSnapshot>,
  commissionRatePercent: number
): { rows: DailyPnlRow[]; total: number; excluded: string[] } {
  const commissionRate = commissionRatePercent / 100;
  const fillPriceOf = (o: Order): number | undefined => {
    if (o.executedPrice !== undefined && o.executedPrice > 0) return o.executedPrice;
    const qty = o.filledQuantity ?? o.quantity;
    if (o.executedAmount !== undefined && o.executedAmount > 0 && qty && qty > 0) {
      return o.executedAmount / qty;
    }
    if (o.orderType === 'LIMIT' && o.price !== undefined && o.price > 0) return o.price;
    return undefined;
  };
  const filledQtyOf = (o: Order): number => {
    const qty = o.filledQuantity !== undefined && o.filledQuantity > 0 ? o.filledQuantity : o.quantity ?? 0;
    return qty > 0 ? qty : 0;
  };
  const isFilled = (o: Order) => o.status === 'FILLED' || (o.filledQuantity ?? 0) > 0;

  // 종목별 체결 이벤트(시간순)
  const events = new Map<string, { side: 'BUY' | 'SELL'; price: number; qty: number; t: number }[]>();
  const excluded = new Set<string>();
  for (const o of orders) {
    if ((o.side !== 'BUY' && o.side !== 'SELL') || !isFilled(o)) continue;
    const price = fillPriceOf(o);
    const qty = filledQtyOf(o);
    if (price === undefined || qty <= 0) {
      excluded.add(o.symbol);
      continue;
    }
    const list = events.get(o.symbol) ?? [];
    list.push({ side: o.side, price, qty, t: o.orderedAt ? new Date(o.orderedAt).getTime() : 0 });
    events.set(o.symbol, list);
  }

  const rows: DailyPnlRow[] = [];
  for (const [symbol, list] of events) {
    if (excluded.has(symbol)) continue; // 체결가 미상 주문이 섞이면 재구성이 어긋남 — 제외
    list.sort((a, b) => a.t - b.t);
    if (!list.some((e) => e.side === 'SELL')) continue; // 매도 없으면 실현 손익 없음

    // 1) 역순 되감기 — 현재 보유에서 오늘 체결을 걷어내 장 시작 시점(수량·평단) 복원.
    //    평균단가법: 매수 되감기는 평단을 역산, 매도 되감기는 수량만 복원(평단 불변).
    const snapshot = holdings[symbol.toUpperCase()];
    let qty = snapshot?.quantity ?? 0;
    let avg: number | undefined =
      snapshot && snapshot.averagePrice > 0 ? snapshot.averagePrice : undefined;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const e = list[i];
      if (e.side === 'BUY') {
        const prevQty = qty - e.qty;
        if (prevQty > QTY_EPS && avg !== undefined) {
          avg = (avg * qty - e.price * e.qty) / prevQty;
          qty = prevQty;
        } else {
          // 이 매수로 포지션이 시작됨 — 그 이전은 무포지션.
          qty = 0;
          avg = undefined;
        }
      } else {
        qty += e.qty; // 매도 되감기 — 평단은 그대로
      }
    }

    // 이월 보유가 있는데 평단을 복원 못 한 경우(현재 전량 청산 등) — 정확 계산 불가.
    if (qty > QTY_EPS && avg === undefined) {
      excluded.add(symbol);
      continue;
    }

    // 2) 시간순 재생 — 각 매도 시점의 평단으로 실현 손익 누적(왕복 수수료 차감).
    let runQty = qty;
    let runAvg = avg;
    let realized = 0;
    let soldQty = 0;
    let broken = false;
    for (const e of list) {
      if (e.side === 'BUY') {
        runAvg =
          runQty > QTY_EPS && runAvg !== undefined
            ? (runAvg * runQty + e.price * e.qty) / (runQty + e.qty)
            : e.price;
        runQty += e.qty;
      } else {
        if (runAvg === undefined || runQty <= QTY_EPS) {
          broken = true; // 보유 없이 매도 기록 — 데이터 불일치
          break;
        }
        const sellQty = Math.min(e.qty, runQty);
        realized += (e.price - runAvg) * sellQty - (e.price + runAvg) * sellQty * commissionRate;
        soldQty += sellQty;
        runQty -= sellQty;
      }
    }
    if (broken) {
      excluded.add(symbol);
      continue;
    }
    rows.push({ symbol, realized, soldQty });
  }

  rows.sort((a, b) => Math.abs(b.realized) - Math.abs(a.realized));
  return {
    rows,
    total: rows.reduce((sum, r) => sum + r.realized, 0),
    excluded: [...excluded].filter((sym) => !rows.some((r) => r.symbol === sym)),
  };
}

export function OrderHistoryModal({
  onClose,
  holdingsSnapshot = {},
}: {
  onClose: () => void;
  /** 종목별 현재 보유(수량·평단) — 오늘 체결을 되감아 매도 시점 평단을 복원하는 기준. */
  holdingsSnapshot?: Record<string, HoldingSnapshot>;
}) {
  const { selectedAccountSeq } = useAppContext();
  const [rangeDays, setRangeDays] = useState<number>(7);
  const [orders, setOrders] = useState<Order[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (days: number, cursor?: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = unwrapResult(
          await api.getOrders(
            {
              status: 'CLOSED',
              from: kstDateStr(days),
              to: kstDateStr(0),
              limit: PAGE_LIMIT,
              cursor,
            },
            selectedAccountSeq
          )
        );
        const mapped = mapOrders(res);
        setOrders((prev) => (cursor ? [...prev, ...mapped] : mapped));
        setNextCursor(res?.nextCursor ?? null);
        setHasNext(Boolean(res?.hasNext && res?.nextCursor));
      } catch (e) {
        setError(e instanceof Error ? e.message : '주문내역 조회에 실패했습니다.');
      } finally {
        setLoading(false);
      }
    },
    [selectedAccountSeq]
  );

  useEffect(() => {
    void fetchPage(rangeDays);
  }, [rangeDays, fetchPage]);

  // 당일 실현 손익(추정) — 선택한 기간과 무관하게 항상 '오늘' 체결 기준으로 별도 조회.
  const [todayOrders, setTodayOrders] = useState<Order[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = unwrapResult(
          await api.getOrders(
            { status: 'CLOSED', from: kstDateStr(0), to: kstDateStr(0), limit: 100 },
            selectedAccountSeq
          )
        );
        if (!cancelled && res) setTodayOrders(mapOrders(res));
      } catch {
        if (!cancelled) setTodayOrders([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedAccountSeq]);
  // 계좌 실제 수수료율(US) — 실패 시 기본값 폴백.
  const [commissionRatePercent, setCommissionRatePercent] = useState<number>(
    resolveUsCommissionRatePercent(undefined)
  );
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = unwrapResult(await api.getCommissions(selectedAccountSeq));
        if (!cancelled && res) setCommissionRatePercent(resolveUsCommissionRatePercent(res));
      } catch {
        // 기본 요율 유지
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedAccountSeq]);
  const dailyPnl = todayOrders
    ? computeDailyPnl(todayOrders, holdingsSnapshot, commissionRatePercent)
    : null;

  // ESC 닫기 + 배경 스크롤 잠금 (다른 전체 모달과 동일 패턴)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return createPortal(
    <div className="backtest-modal__overlay" onClick={onClose} role="presentation">
      <div
        className="backtest-modal order-history-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="주문 내역"
      >
        <div className="backtest-modal__head">
          <Typography size={16} as="h2" className="backtest-modal__title">주문 내역</Typography>
          <button type="button" className="backtest-modal__close" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>
        <div className="backtest-modal__body">
        <div className="order-history-modal__filters" role="tablist" aria-label="조회 기간">
          {RANGE_OPTIONS.map((opt) => (
            <Chip
              key={opt.label}
              selected={rangeDays === opt.days}
              onClick={() => setRangeDays(opt.days)}
            >
              {opt.label}
            </Chip>
          ))}
        </div>

        {dailyPnl && (dailyPnl.rows.length > 0 || dailyPnl.excluded.length > 0) && (
          <div className="order-history-modal__pnl">
            <div className="order-history-modal__pnl-head">
              <Typography size={14}>오늘 실현 손익 (추정)</Typography>
              <Typography
                size={16}
                className={`order-history-modal__pnl-total ${dailyPnl.total > 0 ? 'is-buy' : dailyPnl.total < 0 ? 'is-sell' : ''}`}
              >
                {dailyPnl.total >= 0 ? '+' : ''}${dailyPnl.total.toFixed(2)}
              </Typography>
            </div>
            {dailyPnl.rows.length > 0 && (
              <div className="order-history-modal__pnl-rows">
                {dailyPnl.rows.map((r) => (
                  <Typography key={r.symbol} size={12} className="order-history-modal__pnl-row">
                    {r.symbol} {r.realized >= 0 ? '+' : ''}${r.realized.toFixed(2)}
                  </Typography>
                ))}
              </div>
            )}
            <Typography size={12} as="p" className="hint order-history-modal__pnl-note">
              매도 시점 평단 기준(평균단가법 재구성) − 왕복 수수료({(commissionRatePercent * 2).toFixed(2)}%)
              {dailyPnl.excluded.length > 0 ? ` · 계산 불가 제외: ${dailyPnl.excluded.join(', ')}` : ''}
            </Typography>
          </div>
        )}

        {error && <div className="banner error">{error}</div>}

        {orders.length === 0 && !loading && !error ? (
          <Typography size={14} as="p" className="hint">
            해당 기간에 종료된 주문이 없습니다.
          </Typography>
        ) : (
          <ul className="order-history-list order-history-modal__list">
            {orders.map((order) => (
              <li key={order.orderId} className="order-history-item">
                <div className="order-history-item__content">
                  <Typography size={14} className="order-history-item__date-symbol">
                    {formatOrderDateLabel(order.orderedAt)} {order.symbol}
                  </Typography>
                  <div className="order-history-item__summary">
                    <Typography size={14} className="order-history-item__price">
                      {formatOrderPriceLabel(order)} · {quantityLabel(order)}
                    </Typography>
                    <div className="order-history-item__status-row">
                      <Typography
                        size={12}
                        className={`order-history-item__status${order.side === 'BUY' ? ' is-buy' : ' is-sell'}`}
                      >
                        {order.side === 'BUY' ? '매수' : '매도'} · {statusLabel(order)}
                      </Typography>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="order-history-modal__foot">
          {loading && (
            <Typography size={12} className="hint">
              불러오는 중…
            </Typography>
          )}
          {!loading && hasNext && nextCursor && (
            <Button size="sm" onClick={() => void fetchPage(rangeDays, nextCursor)}>
              더 보기
            </Button>
          )}
        </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

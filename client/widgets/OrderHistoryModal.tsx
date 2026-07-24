import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../shared/api/client';
import { unwrapResult } from '../shared/lib/parse';
import { mapOrders } from '../shared/lib/mapPortfolio';
import { formatOrderDateLabel, formatOrderPriceLabel } from '../shared/lib/formatOrders';
import { useAppContext } from '../app/providers/AppContext';
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

/** 오늘 체결된 매도의 실현 손익(추정) — (체결가 − 원가) × 수량.
 *  원가는 보유 평단 → 없으면(전량 청산) 당일 매수 평균가 → 둘 다 없으면 제외. */
function computeDailyPnl(
  orders: Order[],
  holdingsAvgPrices: Record<string, number>
): { rows: DailyPnlRow[]; total: number; excluded: string[] } {
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

  // 당일 매수 평균가(전량 청산 종목의 원가 폴백)
  const buyAgg = new Map<string, { cost: number; qty: number }>();
  for (const o of orders) {
    if (o.side !== 'BUY' || !isFilled(o)) continue;
    const price = fillPriceOf(o);
    const qty = filledQtyOf(o);
    if (price === undefined || qty <= 0) continue;
    const agg = buyAgg.get(o.symbol) ?? { cost: 0, qty: 0 };
    agg.cost += price * qty;
    agg.qty += qty;
    buyAgg.set(o.symbol, agg);
  }

  const rowMap = new Map<string, DailyPnlRow>();
  const excluded = new Set<string>();
  for (const o of orders) {
    if (o.side !== 'SELL' || !isFilled(o)) continue;
    const price = fillPriceOf(o);
    const qty = filledQtyOf(o);
    if (price === undefined || qty <= 0) {
      excluded.add(o.symbol);
      continue;
    }
    const buy = buyAgg.get(o.symbol);
    const cost = holdingsAvgPrices[o.symbol.toUpperCase()] ?? (buy && buy.qty > 0 ? buy.cost / buy.qty : undefined);
    if (cost === undefined || cost <= 0) {
      excluded.add(o.symbol);
      continue;
    }
    const row = rowMap.get(o.symbol) ?? { symbol: o.symbol, realized: 0, soldQty: 0 };
    row.realized += (price - cost) * qty;
    row.soldQty += qty;
    rowMap.set(o.symbol, row);
  }
  const rows = [...rowMap.values()].sort((a, b) => Math.abs(b.realized) - Math.abs(a.realized));
  return {
    rows,
    total: rows.reduce((sum, r) => sum + r.realized, 0),
    excluded: [...excluded].filter((sym) => !rowMap.has(sym)),
  };
}

export function OrderHistoryModal({
  onClose,
  holdingsAvgPrices = {},
}: {
  onClose: () => void;
  /** 종목별 보유 평단 — 당일 실현 손익(추정) 계산의 원가 기준. */
  holdingsAvgPrices?: Record<string, number>;
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
  const dailyPnl = todayOrders ? computeDailyPnl(todayOrders, holdingsAvgPrices) : null;

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
              매도 체결 × (체결가 − 평단) 기준 추정치 · 수수료 제외
              {dailyPnl.excluded.length > 0 ? ` · 원가 미상 제외: ${dailyPnl.excluded.join(', ')}` : ''}
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

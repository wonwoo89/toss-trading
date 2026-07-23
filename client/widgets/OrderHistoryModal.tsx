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
export function OrderHistoryModal({ onClose }: { onClose: () => void }) {
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

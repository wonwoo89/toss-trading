import { useMemo } from 'react';
import {
  buildSpreadSnapshot,
  buildTradeFlowSnapshot,
  type MicrostructureBias,
} from '../shared/lib/marketMicrostructure';
import { formatPrice, formatQuantity } from '../shared/lib/formatHoldings';
import { emitLimitPriceSelect } from '../shared/lib/limitPriceBus';
import { Typography } from '../shared/ui/Typography';

interface OrderbookEntry {
  price: number;
  quantity: number;
}

interface OrderbookPanelProps {
  bids: OrderbookEntry[];
  asks: OrderbookEntry[];
  trades: { price: number; quantity: number; timestamp: string }[];
  currency: string;
}

const DEPTH_LEVELS = 8;

function getMetricBiasClass(bias: MicrostructureBias) {
  if (bias === 'bullish') return 'orderbook-summary__metric--bullish';
  if (bias === 'bearish') return 'orderbook-summary__metric--bearish';
  return 'orderbook-summary__metric--neutral';
}

interface DepthRow {
  price: number;
  quantity: number;
  cumulative: number;
}

/**
 * 호가 패널 — 체결흐름 요약 + 뎁스(누적·바) + 총잔량/불균형/중간값/마이크로프라이스 + 체결.
 * 항상 전체 펼침(신규 레이아웃 고정으로 접힘 모드 제거). 1호가·스프레드는 뎁스 테이블이 표시.
 */
export function OrderbookPanel({ bids, asks, trades, currency }: OrderbookPanelProps) {
  const spread = useMemo(() => buildSpreadSnapshot(bids, asks), [bids, asks]);
  const tradeFlow = useMemo(() => buildTradeFlowSnapshot(trades, bids, asks), [trades, bids, asks]);

  // 뎁스 계산: 매도=가격 오름차순(최우선 1호가부터 누적), 매수=가격 내림차순.
  const depth = useMemo(() => {
    const asksAsc = [...asks].sort((a, b) => a.price - b.price).slice(0, DEPTH_LEVELS);
    const bidsDesc = [...bids].sort((a, b) => b.price - a.price).slice(0, DEPTH_LEVELS);

    const askRows: DepthRow[] = [];
    let cum = 0;
    for (const a of asksAsc) {
      cum += a.quantity;
      askRows.push({ price: a.price, quantity: a.quantity, cumulative: cum });
    }
    const bidRows: DepthRow[] = [];
    cum = 0;
    for (const b of bidsDesc) {
      cum += b.quantity;
      bidRows.push({ price: b.price, quantity: b.quantity, cumulative: cum });
    }

    // 바 스케일은 표시 구간 양쪽 최대 잔량 기준(좌우 비교 일관).
    const maxQty = Math.max(
      1,
      ...askRows.map((r) => r.quantity),
      ...bidRows.map((r) => r.quantity)
    );

    const bidTotal = bids.reduce((s, b) => s + b.quantity, 0);
    const askTotal = asks.reduce((s, a) => s + a.quantity, 0);
    const total = bidTotal + askTotal;
    const bidRatio = total > 0 ? bidTotal / total : 0.5;

    const bAsk = asksAsc[0];
    const bBid = bidsDesc[0];
    let mid: number | undefined;
    let micro: number | undefined;
    if (bAsk && bBid && bAsk.price > 0 && bBid.price > 0) {
      mid = (bAsk.price + bBid.price) / 2;
      const denom = bAsk.quantity + bBid.quantity;
      // 마이크로프라이스: 반대편 잔량으로 가중한 공정가(잔량이 적은 쪽으로 치우침 → 단기 방향 힌트).
      micro = denom > 0 ? (bBid.price * bAsk.quantity + bAsk.price * bBid.quantity) / denom : mid;
    }

    return { askRows, bidRows, maxQty, bidTotal, askTotal, bidRatio, mid, micro };
  }, [bids, asks]);

  const imbalancePct = Math.round(depth.bidRatio * 100);
  // 매도 행은 위(높은가)→아래(최우선) 순으로 표시: 스프레드 쪽이 아래로 모이게 reverse.
  const askRowsDisplay = [...depth.askRows].reverse();

  return (
    <div className="orderbook">
      <div className="orderbook-summary">
        <div className="orderbook-summary__metrics" aria-live="polite">
          <span className={`orderbook-summary__metric ${getMetricBiasClass(tradeFlow.bias)}`}>
            <Typography size={12} className="orderbook-summary__metric-label">{tradeFlow.label}</Typography>
            <Typography size={12} className="orderbook-summary__metric-value">{tradeFlow.value}</Typography>
          </span>
        </div>
      </div>

      <div className="orderbook-detail">
        {/* 잔량 불균형 / 중간값 / 마이크로프라이스 */}
        <div className="orderbook-stats">
          <span className="orderbook-stat">
            <Typography size={10} className="orderbook-stat__label">매수/매도 잔량</Typography>
            <Typography size={12} className="orderbook-stat__value">
              <Typography size={12} className="up">{formatQuantity(depth.bidTotal)}</Typography>
              {' / '}
              <Typography size={12} className="down">{formatQuantity(depth.askTotal)}</Typography>
            </Typography>
          </span>
          <span className="orderbook-stat">
            <Typography size={10} className="orderbook-stat__label">불균형</Typography>
            <Typography
              size={12}
              className={`orderbook-stat__value ${imbalancePct >= 55 ? 'up' : imbalancePct <= 45 ? 'down' : ''}`}
            >
              매수 {imbalancePct}%
            </Typography>
          </span>
          <span className="orderbook-stat">
            <Typography size={10} className="orderbook-stat__label">중간값</Typography>
            <Typography size={12} className="orderbook-stat__value">{formatPrice(depth.mid, currency)}</Typography>
          </span>
          <span
            className="orderbook-stat"
            title="마이크로프라이스: 양측 잔량으로 가중한 공정가. 중간값보다 한쪽으로 치우치면 그 방향으로의 단기 압력을 시사."
          >
            <Typography size={10} className="orderbook-stat__label">마이크로</Typography>
            <Typography size={12} className="orderbook-stat__value">{formatPrice(depth.micro, currency)}</Typography>
          </span>
        </div>

        {/* 뎁스 호가(매도 위 / 매수 아래) — 누적 + 뎁스 바 */}
        <div className="orderbook-depth">
          <div className="orderbook-depth__head">
            <Typography size={10}>누적</Typography>
            <Typography size={10}>잔량</Typography>
            <Typography size={10}>가격</Typography>
          </div>
          {askRowsDisplay.length === 0 ? (
            <Typography size={12} as="div" className="orderbook-depth__empty">매도호가 없음</Typography>
          ) : (
            askRowsDisplay.map((r, i) => (
              <div className="orderbook-row is-ask" key={`ask-${i}`}>
                <span
                  className="orderbook-row__bar is-ask"
                  style={{ width: `${Math.min(100, (r.quantity / depth.maxQty) * 100)}%` }}
                />
                <Typography size={12} className="orderbook-row__cum">{formatQuantity(r.cumulative)}</Typography>
                <Typography size={12} className="orderbook-row__qty">{formatQuantity(r.quantity)}</Typography>
                <button
                  type="button"
                  className="orderbook-row__price orderbook-price-btn down"
                  title="탭하면 지정가로 입력"
                  onClick={() => emitLimitPriceSelect(r.price)}
                >
                  {formatPrice(r.price, currency)}
                </button>
              </div>
            ))
          )}

          <div className="orderbook-depth__mid">
            <Typography size={10}>스프레드 {spread.spread !== undefined ? formatPrice(spread.spread, currency) : '—'}</Typography>
            {spread.spreadPercent !== undefined && <Typography size={10}>({spread.spreadPercent.toFixed(3)}%)</Typography>}
          </div>

          {depth.bidRows.length === 0 ? (
            <Typography size={12} as="div" className="orderbook-depth__empty">매수호가 없음</Typography>
          ) : (
            depth.bidRows.map((r, i) => (
              <div className="orderbook-row is-bid" key={`bid-${i}`}>
                <span
                  className="orderbook-row__bar is-bid"
                  style={{ width: `${Math.min(100, (r.quantity / depth.maxQty) * 100)}%` }}
                />
                <Typography size={12} className="orderbook-row__cum">{formatQuantity(r.cumulative)}</Typography>
                <Typography size={12} className="orderbook-row__qty">{formatQuantity(r.quantity)}</Typography>
                <button
                  type="button"
                  className="orderbook-row__price orderbook-price-btn up"
                  title="탭하면 지정가로 입력"
                  onClick={() => emitLimitPriceSelect(r.price)}
                >
                  {formatPrice(r.price, currency)}
                </button>
              </div>
            ))
          )}
        </div>

        {/* 최근 체결 */}
        <div className="orderbook-trades">
          <div className="orderbook-trades__head">
            <Typography size={10}>시간</Typography>
            <Typography size={10}>가격</Typography>
            <Typography size={10}>수량</Typography>
          </div>
          {trades.length === 0 ? (
            <Typography size={12} as="div" className="orderbook-depth__empty">체결 없음</Typography>
          ) : (
            trades.slice(0, 12).map((t, i) => (
              <div className="orderbook-trade" key={`trade-${i}`}>
                <Typography size={10}>{new Date(t.timestamp).toLocaleTimeString('ko-KR')}</Typography>
                <Typography size={10}>{formatPrice(t.price, currency)}</Typography>
                <Typography size={10}>{formatQuantity(t.quantity)}</Typography>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

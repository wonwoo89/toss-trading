import { useMemo } from 'react';
import {
  buildSpreadSnapshot,
  buildTradeFlowSnapshot,
  classifyTrades,
} from '../shared/lib/marketMicrostructure';
import { buildDaySummary } from '../shared/lib/marketAnalytics';
import { formatPrice, formatQuantity } from '../shared/lib/formatHoldings';
import { emitLimitPriceSelect } from '../shared/lib/limitPriceBus';
import { Typography } from '../shared/ui/Typography';
import type { CandleInterval, ChartCandle } from '../shared/types';

interface OrderbookEntry {
  price: number;
  quantity: number;
}

interface OrderbookPanelProps {
  bids: OrderbookEntry[];
  asks: OrderbookEntry[];
  trades: { price: number; quantity: number; timestamp: string }[];
  currency: string;
  /** 가격별 전일대비 %·색상 계산용. */
  previousClose?: number;
  /** 당일 시가·고저·거래량·VWAP 계산용(차트에 로드된 캔들 재사용). */
  candles?: ChartCandle[];
  candleInterval?: CandleInterval;
}

const DEPTH_LEVELS = 10;
const TRADE_ROWS = 14;

/** 219만 7,000 식의 만 단위 표기(토스풍). */
function formatVolumeKr(volume: number): string {
  if (!Number.isFinite(volume) || volume <= 0) return '—';
  const rounded = Math.round(volume);
  if (rounded < 10_000) return rounded.toLocaleString('ko-KR');
  const man = Math.floor(rounded / 10_000);
  const rest = rounded % 10_000;
  return rest > 0
    ? `${man.toLocaleString('ko-KR')}만 ${rest.toLocaleString('ko-KR')}`
    : `${man.toLocaleString('ko-KR')}만`;
}

/**
 * 호가 패널 — 토스형 3열 사다리.
 * [매도잔량 | 가격(전일대비%) | 종목정보]  ← 매도 구간
 * [체결강도·체결 | 가격(전일대비%) | 매수잔량]  ← 매수 구간
 * 가격을 탭하면 주문폼 지정가로 입력된다.
 */
export function OrderbookPanel({
  bids,
  asks,
  trades,
  currency,
  previousClose,
  candles,
  candleInterval,
}: OrderbookPanelProps) {
  const spread = useMemo(() => buildSpreadSnapshot(bids, asks), [bids, asks]);
  const tradeFlow = useMemo(() => buildTradeFlowSnapshot(trades, bids, asks), [trades, bids, asks]);
  const classifiedTrades = useMemo(
    () => classifyTrades(trades, bids, asks).slice(0, TRADE_ROWS),
    [trades, bids, asks]
  );
  const daySummary = useMemo(
    () => (candles && candleInterval ? buildDaySummary(candles, candleInterval) : null),
    [candles, candleInterval]
  );

  const depth = useMemo(() => {
    const asksAsc = [...asks].sort((a, b) => a.price - b.price).slice(0, DEPTH_LEVELS);
    const bidsDesc = [...bids].sort((a, b) => b.price - a.price).slice(0, DEPTH_LEVELS);
    // 매도는 위(높은가)→아래(최우선)로 표시.
    const asksDisplay = [...asksAsc].reverse();

    const maxQty = Math.max(
      1,
      ...asksAsc.map((r) => r.quantity),
      ...bidsDesc.map((r) => r.quantity)
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

    return { asksDisplay, bidsDesc, maxQty, bidTotal, askTotal, bidRatio, mid, micro };
  }, [bids, asks]);

  // 전일대비 방향(색)과 % — 전일종가 없으면 중립.
  const dirClass = (price: number) => {
    if (previousClose === undefined || previousClose <= 0) return '';
    return price > previousClose ? 'up' : price < previousClose ? 'down' : '';
  };
  const pctText = (price: number) => {
    if (previousClose === undefined || previousClose <= 0) return null;
    const pct = ((price - previousClose) / previousClose) * 100;
    return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
  };

  // 체결강도 = 매수체결량/매도체결량 ×100 (>100 매수 우위).
  const strength =
    tradeFlow.sellVolume > 0 ? (tradeFlow.buyVolume / tradeFlow.sellVolume) * 100 : undefined;

  const imbalancePct = Math.round(depth.bidRatio * 100);

  const renderQtyRow = (row: OrderbookEntry, side: 'ask' | 'bid', key: string) => (
    <div className={`obl__row obl__qty is-${side}`} key={key}>
      <span
        className="obl__qty-bar"
        style={{ width: `${Math.min(100, (row.quantity / depth.maxQty) * 100)}%` }}
      />
      <Typography size={12} className="obl__qty-text">
        {formatQuantity(row.quantity)}
      </Typography>
    </div>
  );

  const renderPriceRow = (row: OrderbookEntry, key: string) => {
    const pct = pctText(row.price);
    return (
      <div className="obl__row" key={key}>
        <button
          type="button"
          className={`obl__price ${dirClass(row.price)}`}
          title="탭하면 지정가로 입력"
          onClick={() => emitLimitPriceSelect(row.price)}
        >
          <Typography size={14} className="obl__price-main">
            {formatPrice(row.price, currency)}
          </Typography>
          {pct && <Typography size={10} className="obl__price-pct">{pct}</Typography>}
        </button>
      </div>
    );
  };

  const infoRow = (label: string, value: string | null, valueClass = '') => (
    <div className="obl__info-row" key={label}>
      <Typography size={10} className="obl__info-label">{label}</Typography>
      <Typography size={12} className={`obl__info-value ${valueClass}`}>{value ?? '—'}</Typography>
    </div>
  );

  return (
    <div className="orderbook">
      <div className="obl">
        {/* 매도 구간: 잔량 | 가격 */}
        <div className="obl__zone obl__askq">
          {depth.asksDisplay.map((r, i) => renderQtyRow(r, 'ask', `askq-${i}`))}
        </div>
        <div className="obl__zone obl__askp">
          {depth.asksDisplay.length === 0 ? (
            <Typography size={12} as="div" className="obl__empty">매도호가 없음</Typography>
          ) : (
            depth.asksDisplay.map((r, i) => renderPriceRow(r, `askp-${i}`))
          )}
        </div>

        {/* 우상단: 종목·당일 정보 */}
        <div className="obl__zone obl__info">
          <div className="obl__info-group">
            {infoRow('전일종가', previousClose ? formatPrice(previousClose, currency) : null)}
          </div>
          <div className="obl__info-group">
            {infoRow(
              '시작',
              daySummary ? formatPrice(daySummary.open, currency) : null,
              daySummary ? dirClass(daySummary.open) : ''
            )}
            {infoRow(
              '최고',
              daySummary ? formatPrice(daySummary.high, currency) : null,
              daySummary ? dirClass(daySummary.high) : ''
            )}
            {infoRow(
              '최저',
              daySummary ? formatPrice(daySummary.low, currency) : null,
              daySummary ? dirClass(daySummary.low) : ''
            )}
            {infoRow('거래량', daySummary ? formatVolumeKr(daySummary.volume) : null)}
          </div>
          <div className="obl__info-group">
            {infoRow(
              'VWAP',
              daySummary?.vwap !== undefined ? formatPrice(daySummary.vwap, currency) : null
            )}
            {infoRow('중간값', depth.mid !== undefined ? formatPrice(depth.mid, currency) : null)}
            <div
              className="obl__info-row"
              title="마이크로프라이스: 양측 잔량으로 가중한 공정가. 중간값보다 한쪽으로 치우치면 그 방향으로의 단기 압력을 시사."
            >
              <Typography size={10} className="obl__info-label">마이크로</Typography>
              <Typography size={12} className="obl__info-value">
                {depth.micro !== undefined ? formatPrice(depth.micro, currency) : '—'}
              </Typography>
            </div>
          </div>
        </div>

        {/* 좌하단: 체결강도 + 최근 체결(방향 색) */}
        <div className="obl__zone obl__trades">
          <div className="obl__trades-head">
            <Typography size={10} className="obl__info-label">체결강도</Typography>
            <Typography
              size={12}
              className={`obl__trades-strength ${
                strength === undefined ? '' : strength >= 100 ? 'up' : 'down'
              }`}
            >
              {strength !== undefined ? `${strength.toFixed(2)}%` : '—'}
            </Typography>
          </div>
          {classifiedTrades.length === 0 ? (
            <Typography size={12} as="div" className="obl__empty">체결 없음</Typography>
          ) : (
            classifiedTrades.map((t, i) => (
              <div className="obl__trade" key={`trade-${i}`}>
                <Typography size={12} className="obl__trade-price">
                  {formatPrice(t.price, currency)}
                </Typography>
                <Typography
                  size={12}
                  className={`obl__trade-qty ${
                    t.side === 'buy' ? 'up' : t.side === 'sell' ? 'down' : ''
                  }`}
                >
                  {formatQuantity(t.quantity)}
                </Typography>
              </div>
            ))
          )}
        </div>

        {/* 매수 구간: 가격 | 잔량 */}
        <div className="obl__zone obl__bidp">
          {depth.bidsDesc.length === 0 ? (
            <Typography size={12} as="div" className="obl__empty">매수호가 없음</Typography>
          ) : (
            depth.bidsDesc.map((r, i) => renderPriceRow(r, `bidp-${i}`))
          )}
        </div>
        <div className="obl__zone obl__bidq">
          {depth.bidsDesc.map((r, i) => renderQtyRow(r, 'bid', `bidq-${i}`))}
        </div>
      </div>

      {/* 하단 요약: 총잔량·불균형·스프레드·체결흐름 */}
      <div className="obl__foot" aria-live="polite">
        <span className="obl__foot-stat">
          <Typography size={10} className="obl__info-label">매수/매도 잔량</Typography>
          <Typography size={12} className="obl__info-value">
            <Typography size={12} className="up">{formatQuantity(depth.bidTotal)}</Typography>
            {' / '}
            <Typography size={12} className="down">{formatQuantity(depth.askTotal)}</Typography>
          </Typography>
        </span>
        <span className="obl__foot-stat">
          <Typography size={10} className="obl__info-label">불균형</Typography>
          <Typography
            size={12}
            className={`obl__info-value ${imbalancePct >= 55 ? 'up' : imbalancePct <= 45 ? 'down' : ''}`}
          >
            매수 {imbalancePct}%
          </Typography>
        </span>
        <span className="obl__foot-stat">
          <Typography size={10} className="obl__info-label">스프레드</Typography>
          <Typography size={12} className="obl__info-value">{spread.value}</Typography>
        </span>
        <span className="obl__foot-stat">
          <Typography size={10} className="obl__info-label">{tradeFlow.label}</Typography>
          <Typography size={12} className="obl__info-value">{tradeFlow.value}</Typography>
        </span>
      </div>
    </div>
  );
}

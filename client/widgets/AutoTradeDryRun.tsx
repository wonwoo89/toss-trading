import { useEffect, useRef, useState } from 'react';
import {
  calculateTakeProfitSellPrice,
  getTakeProfitCostContext,
} from '../shared/lib/takeProfitSell';
import type { HoldingItem } from '../shared/types';

interface AutoTradeDryRunProps {
  symbol: string;
  currentPrice?: number;
  holding?: HoldingItem;
  /** 매도 가능 수량(effectiveSellableQuantity) */
  sellableQuantity?: number;
  takeProfitRatePercent: number;
  /** 추천 매수(신호 기반)가 추천 상태인지 */
  buyRecommended: boolean;
  buyQuantity?: number;
  buyEntryPrice?: number;
  buyTargetSellPrice?: number;
}

interface DryRunLogEntry {
  id: string;
  time: string;
  side: 'BUY' | 'SELL';
  text: string;
}

const MAX_LOG = 30;

/**
 * 자동매매 1단계 — 드라이런(모의). 실주문은 절대 넣지 않고, 현재 종목의
 * 추천 매수 신호 / 목표 도달 매도 신호가 '발생하는 순간'을 감지해 "했을 주문"만 기록한다.
 * 데스크탑 전용 + 브라우저 켜진 동안만(렌더된 동안만) 동작 — 호출부(OrderForm)에서 데스크탑일 때만 렌더한다.
 *
 * 매도 트리거는 '목표 도달 시 전량(매도가능 수량) 매도' 기준 — 수동 추천매도(일부)와 분리된 자동매매 전용 로직.
 */
export function AutoTradeDryRun({
  symbol,
  currentPrice,
  holding,
  sellableQuantity,
  takeProfitRatePercent,
  buyRecommended,
  buyQuantity,
  buyEntryPrice,
  buyTargetSellPrice,
}: AutoTradeDryRunProps) {
  const [enabled, setEnabled] = useState(false);
  const [logs, setLogs] = useState<DryRunLogEntry[]>([]);

  // 트리거 중복 방지: 조건이 거짓→참으로 전이될 때 1회만 기록하고, 다시 거짓이 되면 해제.
  const buyArmedRef = useRef(false);
  const sellArmedRef = useRef(false);

  // 종목 변경 시 트리거 상태 리셋(로그는 유지).
  useEffect(() => {
    buyArmedRef.current = false;
    sellArmedRef.current = false;
  }, [symbol]);

  const pushLog = (side: 'BUY' | 'SELL', text: string) => {
    setLogs((prev) =>
      [
        { id: crypto.randomUUID(), time: new Date().toLocaleTimeString('ko-KR'), side, text },
        ...prev,
      ].slice(0, MAX_LOG)
    );
  };

  // 매도(전량) 목표가 — 자동매매 전용 '목표 도달 전량매도' 기준.
  const sellQty =
    sellableQuantity !== undefined && sellableQuantity > 0 ? Math.floor(sellableQuantity) : undefined;
  const sellTargetPrice =
    holding &&
    holding.quantity > 0 &&
    holding.averagePrice !== undefined &&
    holding.averagePrice > 0 &&
    sellQty !== undefined
      ? calculateTakeProfitSellPrice(
          holding.averagePrice,
          sellQty,
          takeProfitRatePercent,
          getTakeProfitCostContext(holding)
        )
      : undefined;
  const sellTargetReached =
    sellTargetPrice !== undefined && currentPrice !== undefined && currentPrice >= sellTargetPrice;

  const buyReady =
    buyRecommended &&
    buyQuantity !== undefined &&
    buyQuantity > 0 &&
    buyEntryPrice !== undefined &&
    buyEntryPrice > 0;

  // 매수 트리거(모의): 추천 매수가 참으로 전이되는 순간 1회 기록.
  useEffect(() => {
    if (!enabled) return;
    if (buyReady) {
      if (!buyArmedRef.current) {
        buyArmedRef.current = true;
        pushLog(
          'BUY',
          `모의 매수 ${symbol} ${buyQuantity}주 @ $${buyEntryPrice!.toFixed(2)}` +
            (buyTargetSellPrice !== undefined
              ? ` → 목표 $${buyTargetSellPrice.toFixed(2)} (+${takeProfitRatePercent}%)`
              : '')
        );
      }
    } else {
      buyArmedRef.current = false;
    }
  }, [enabled, buyReady, symbol, buyQuantity, buyEntryPrice, buyTargetSellPrice, takeProfitRatePercent]);

  // 매도 트리거(모의): 목표 도달이 참으로 전이되는 순간 1회 기록(전량).
  useEffect(() => {
    if (!enabled) return;
    if (sellTargetReached && sellQty !== undefined && currentPrice !== undefined) {
      if (!sellArmedRef.current) {
        sellArmedRef.current = true;
        pushLog(
          'SELL',
          `모의 매도(전량) ${symbol} ${sellQty}주 @ $${currentPrice.toFixed(2)} ` +
            `(목표 +${takeProfitRatePercent}% 도달)`
        );
      }
    } else {
      sellArmedRef.current = false;
    }
  }, [enabled, sellTargetReached, sellQty, currentPrice, symbol, takeProfitRatePercent]);

  return (
    <div className="auto-trade-dryrun">
      <div className="auto-trade-dryrun__head">
        <label className="checkbox auto-trade-dryrun__toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          자동매매 드라이런 <span className="auto-trade-dryrun__badge">모의 · 실행 안 함</span>
        </label>
        {logs.length > 0 && (
          <button type="button" className="auto-trade-dryrun__clear" onClick={() => setLogs([])}>
            지우기
          </button>
        )}
      </div>

      <p className="auto-trade-dryrun__hint">
        켜두면 현재 종목의 추천 매수·목표 도달 매도 신호가 발생할 때 “했을 주문”을 기록만 합니다. 실제
        주문은 들어가지 않습니다.
      </p>

      {enabled && (
        <ul className="auto-trade-dryrun__log">
          {logs.length === 0 ? (
            <li className="auto-trade-dryrun__empty">아직 감지된 신호 없음…</li>
          ) : (
            logs.map((log) => (
              <li
                key={log.id}
                className={`auto-trade-dryrun__row ${log.side === 'BUY' ? 'is-buy' : 'is-sell'}`}
              >
                <span className="auto-trade-dryrun__time">{log.time}</span>
                <span className="auto-trade-dryrun__text">{log.text}</span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

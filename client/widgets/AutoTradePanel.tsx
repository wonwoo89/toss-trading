import { useEffect, useRef, useState } from 'react';
import {
  calculateTakeProfitSellPrice,
  getTakeProfitCostContext,
} from '../shared/lib/takeProfitSell';
import type { HoldingItem } from '../shared/types';

type AutoMode = 'off' | 'dryrun' | 'semi';
type AutoActionKind = 'BUY' | 'TP' | 'SL'; // 매수 / 익절 매도 / 손절 매도

interface AutoTradePanelProps {
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
  /** 주문 제출 중 — 실행 버튼 비활성 */
  submitting?: boolean;
  /** 실제 주문 실행(세미오토 '실행' 탭 시). OrderForm 의 검증된 제출 경로 재사용. */
  onAutoExecute: (side: 'BUY' | 'SELL', quantity: number, limitPrice?: number) => void;
}

interface LogEntry {
  id: string;
  time: string;
  level: 'trigger' | 'exec' | 'skip' | 'block';
  side: 'BUY' | 'SELL';
  text: string;
}

interface PendingAction {
  id: string;
  kind: AutoActionKind;
  side: 'BUY' | 'SELL';
  quantity: number;
  limitPrice?: number;
  label: string;
}

const MAX_LOG = 40;
const COOLDOWN_MS = 60_000; // 연속 실행 최소 간격
// 같은 종류(매수/익절/손절) 트리거 재기록·재대기 최소 간격 — 추천이 추천↔비추천으로
// 깜빡일 때 같은 신호가 도배되는 것을 막는다.
const TRIGGER_COOLDOWN_MS = 180_000;
const DAILY_LIMIT_DEFAULT = 10;
const STOP_LOSS_DEFAULT = 2;
const DAILY_KEY = 'autoTradeDailyCount';

function todayKey() {
  return new Date().toLocaleDateString('en-CA');
}
function readDailyCount(): number {
  try {
    const raw = JSON.parse(localStorage.getItem(DAILY_KEY) ?? '{}');
    return raw.date === todayKey() ? Number(raw.count) || 0 : 0;
  } catch {
    return 0;
  }
}
function writeDailyCount(count: number) {
  try {
    localStorage.setItem(DAILY_KEY, JSON.stringify({ date: todayKey(), count }));
  } catch {
    /* noop */
  }
}

/**
 * 자동매매 패널 (1~2단계 통합).
 *  - OFF: 비활성(킬 스위치)
 *  - 드라이런: 추천 매수·익절/손절 신호를 감지해 "했을 주문"을 기록만(실주문 X)
 *  - 세미오토: 트리거 시 대기 카드 노출 → 사용자가 '실행' 탭해야 실제 주문(확인 탭 필수)
 *
 * 안전장치: 킬 스위치(모드 OFF) · 손절률 · 일일 실행 한도 · 쿨다운 · 종목당 단일 대기 · 감사로그.
 * 데스크탑 전용 + 렌더된 동안만 동작(호출부에서 데스크탑일 때만 렌더).
 */
export function AutoTradePanel({
  symbol,
  currentPrice,
  holding,
  sellableQuantity,
  takeProfitRatePercent,
  buyRecommended,
  buyQuantity,
  buyEntryPrice,
  buyTargetSellPrice,
  submitting,
  onAutoExecute,
}: AutoTradePanelProps) {
  const [mode, setMode] = useState<AutoMode>('off');
  const [stopLossPercent, setStopLossPercent] = useState(STOP_LOSS_DEFAULT);
  const [dailyLimit, setDailyLimit] = useState(DAILY_LIMIT_DEFAULT);
  const [dailyCount, setDailyCount] = useState(() => readDailyCount());
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [pending, setPending] = useState<PendingAction | null>(null);

  // 조건 전이(거짓→참) 감지용. 종목 변경 시 리셋.
  const buyArmedRef = useRef(false);
  const tpArmedRef = useRef(false);
  const slArmedRef = useRef(false);
  const pendingRef = useRef<PendingAction | null>(null);
  const lastExecRef = useRef(0);
  // 같은 종류 트리거의 마지막 발생 시각 — 신호 깜빡임 도배 억제(TRIGGER_COOLDOWN_MS).
  const lastFiredRef = useRef<Record<AutoActionKind, number>>({ BUY: 0, TP: 0, SL: 0 });
  pendingRef.current = pending;

  useEffect(() => {
    buyArmedRef.current = false;
    tpArmedRef.current = false;
    slArmedRef.current = false;
    lastFiredRef.current = { BUY: 0, TP: 0, SL: 0 };
    setPending(null);
  }, [symbol]);

  const pushLog = (level: LogEntry['level'], side: 'BUY' | 'SELL', text: string) => {
    setLogs((prev) =>
      [
        { id: crypto.randomUUID(), time: new Date().toLocaleTimeString('ko-KR'), level, side, text },
        ...prev,
      ].slice(0, MAX_LOG)
    );
  };

  // 파생 트리거 값 ──────────────────────────────────────────────
  const sellQty =
    sellableQuantity !== undefined && sellableQuantity > 0
      ? Math.floor(sellableQuantity)
      : undefined;
  const hasPosition =
    holding !== undefined &&
    holding.quantity > 0 &&
    holding.averagePrice !== undefined &&
    holding.averagePrice > 0 &&
    sellQty !== undefined;

  const tpPrice =
    hasPosition && holding!.averagePrice
      ? calculateTakeProfitSellPrice(
          holding!.averagePrice,
          sellQty!,
          takeProfitRatePercent,
          getTakeProfitCostContext(holding)
        )
      : undefined;
  const tpReached = tpPrice !== undefined && currentPrice !== undefined && currentPrice >= tpPrice;

  const slPrice =
    hasPosition && holding!.averagePrice
      ? holding!.averagePrice * (1 - stopLossPercent / 100)
      : undefined;
  const slReached = slPrice !== undefined && currentPrice !== undefined && currentPrice <= slPrice;

  const buyReady =
    buyRecommended &&
    buyQuantity !== undefined &&
    buyQuantity > 0 &&
    buyEntryPrice !== undefined &&
    buyEntryPrice > 0;

  const active = mode !== 'off';

  // 트리거 처리: 드라이런=기록만, 세미오토=대기 카드 생성(종목당 1건).
  // 같은 종류 트리거는 TRIGGER_COOLDOWN_MS 안에선 무시 — 고변동 종목에서 추천이 깜빡여도 도배 방지.
  const fireTrigger = (action: PendingAction, dryRunText: string) => {
    const now = Date.now();
    if (now - lastFiredRef.current[action.kind] < TRIGGER_COOLDOWN_MS) return;

    if (mode === 'dryrun') {
      lastFiredRef.current[action.kind] = now;
      pushLog('trigger', action.side, dryRunText);
      return;
    }
    // semi: 이미 대기 중이면 새로 만들지 않음(스팸 방지). 쿨다운 시각도 갱신하지 않음.
    if (pendingRef.current) return;
    lastFiredRef.current[action.kind] = now;
    pendingRef.current = action;
    setPending(action);
    pushLog('trigger', action.side, `대기: ${action.label} — '실행'을 눌러야 주문됩니다`);
  };

  // 매수 트리거
  useEffect(() => {
    if (!active) return;
    if (buyReady) {
      if (!buyArmedRef.current) {
        buyArmedRef.current = true;
        const label = `매수 ${symbol} ${buyQuantity}주 @ $${buyEntryPrice!.toFixed(2)}${buyTargetSellPrice !== undefined ? ` → 목표 $${buyTargetSellPrice.toFixed(2)}` : ''}`;
        fireTrigger(
          {
            id: crypto.randomUUID(),
            kind: 'BUY',
            side: 'BUY',
            quantity: buyQuantity!,
            limitPrice: buyEntryPrice,
            label,
          },
          `모의 ${label}`
        );
      }
    } else {
      buyArmedRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, mode, buyReady, symbol, buyQuantity, buyEntryPrice, buyTargetSellPrice]);

  // 익절 매도 트리거
  useEffect(() => {
    if (!active) return;
    if (tpReached && sellQty !== undefined && currentPrice !== undefined) {
      if (!tpArmedRef.current) {
        tpArmedRef.current = true;
        const label = `익절 매도(전량) ${symbol} ${sellQty}주 @ $${currentPrice.toFixed(2)} (목표 +${takeProfitRatePercent}%)`;
        fireTrigger(
          {
            id: crypto.randomUUID(),
            kind: 'TP',
            side: 'SELL',
            quantity: sellQty,
            limitPrice: currentPrice,
            label,
          },
          `모의 ${label}`
        );
      }
    } else {
      tpArmedRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, mode, tpReached, sellQty, currentPrice, symbol, takeProfitRatePercent]);

  // 손절 매도 트리거
  useEffect(() => {
    if (!active) return;
    if (slReached && sellQty !== undefined && currentPrice !== undefined) {
      if (!slArmedRef.current) {
        slArmedRef.current = true;
        const label = `손절 매도(전량) ${symbol} ${sellQty}주 @ $${currentPrice.toFixed(2)} (손절 -${stopLossPercent}%)`;
        fireTrigger(
          {
            id: crypto.randomUUID(),
            kind: 'SL',
            side: 'SELL',
            quantity: sellQty,
            limitPrice: currentPrice,
            label,
          },
          `모의 ${label}`
        );
      }
    } else {
      slArmedRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, mode, slReached, sellQty, currentPrice, symbol, stopLossPercent]);

  const dismissPending = () => {
    if (pending) pushLog('skip', pending.side, `무시: ${pending.label}`);
    pendingRef.current = null;
    setPending(null);
  };

  const executePending = () => {
    const action = pending;
    if (!action) return;
    if (mode !== 'semi') return; // 킬 스위치
    if (submitting) return;

    // 한도/쿨다운 가드
    const count = readDailyCount();
    if (count >= dailyLimit) {
      pushLog('block', action.side, `차단(일일 한도 ${dailyLimit}회 초과): ${action.label}`);
      return;
    }
    if (Date.now() - lastExecRef.current < COOLDOWN_MS) {
      const wait = Math.ceil((COOLDOWN_MS - (Date.now() - lastExecRef.current)) / 1000);
      pushLog('block', action.side, `차단(쿨다운 ${wait}s 남음): ${action.label}`);
      return;
    }

    onAutoExecute(action.side, action.quantity, action.limitPrice);
    lastExecRef.current = Date.now();
    const next = count + 1;
    writeDailyCount(next);
    setDailyCount(next);
    pushLog('exec', action.side, `실행: ${action.label}`);
    pendingRef.current = null;
    setPending(null);
  };

  const limitReached = dailyCount >= dailyLimit;

  return (
    <div className={`auto-trade ${active ? 'is-active' : ''}`}>
      <div className="auto-trade__head">
        <span className="auto-trade__title">
          자동매매
          {mode === 'semi' && <span className="auto-trade__badge is-semi">세미오토 · 실주문</span>}
          {mode === 'dryrun' && <span className="auto-trade__badge is-dry">드라이런 · 모의</span>}
        </span>
        <div className="auto-trade__modes" role="tablist">
          {(['off', 'dryrun', 'semi'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={`auto-trade__mode ${mode === m ? 'is-on' : ''}`}
              onClick={() => setMode(m)}
            >
              {m === 'off' ? 'OFF' : m === 'dryrun' ? '드라이런' : '세미오토'}
            </button>
          ))}
        </div>
      </div>

      <div className="auto-trade__controls">
        <label className="auto-trade__field">
          손절률
          <input
            type="number"
            min={0.1}
            step={0.1}
            value={stopLossPercent}
            onChange={(e) => setStopLossPercent(Math.max(0.1, Number(e.target.value) || 0))}
          />
          %
        </label>
        <label className="auto-trade__field">
          일일 한도
          <input
            type="number"
            min={1}
            step={1}
            value={dailyLimit}
            onChange={(e) => setDailyLimit(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
          />
          회
        </label>
        <span className={`auto-trade__count ${limitReached ? 'is-reached' : ''}`}>
          오늘 {dailyCount}/{dailyLimit}
        </span>
      </div>

      <p className="auto-trade__hint">
        {mode === 'off'
          ? '꺼짐(킬 스위치). 드라이런=모의 기록, 세미오토=확인 탭 후 실주문. 데스크탑·브라우저 켜둔 동안만 동작.'
          : mode === 'dryrun'
            ? '모의 기록만 — 실제 주문은 들어가지 않습니다.'
            : '트리거 시 아래 대기 카드의 “실행”을 눌러야 실제 주문이 나갑니다. 익절/손절은 전량 매도.'}
      </p>

      {mode === 'semi' && pending && (
        <div className={`auto-trade__pending ${pending.side === 'BUY' ? 'is-buy' : 'is-sell'}`}>
          <span className="auto-trade__pending-label">
            {pending.kind === 'BUY' ? '🟢 매수 대기' : pending.kind === 'TP' ? '🔵 익절 대기' : '🔴 손절 대기'}
          </span>
          <span className="auto-trade__pending-text">{pending.label}</span>
          <div className="auto-trade__pending-actions">
            <button
              type="button"
              className="auto-trade__exec"
              onClick={executePending}
              disabled={submitting || limitReached}
            >
              실행
            </button>
            <button type="button" className="auto-trade__dismiss" onClick={dismissPending}>
              무시
            </button>
          </div>
        </div>
      )}

      {active && (
        <ul className="auto-trade__log">
          {logs.length === 0 ? (
            <li className="auto-trade__empty">아직 감지된 신호 없음…</li>
          ) : (
            logs.map((log) => (
              <li key={log.id} className={`auto-trade__row level-${log.level}`}>
                <span className="auto-trade__time">{log.time}</span>
                <span className="auto-trade__text">{log.text}</span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

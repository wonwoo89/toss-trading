import { useEffect, useRef, useState } from 'react';
import {
  calculateTakeProfitSellPrice,
  getTakeProfitCostContext,
} from '../shared/lib/takeProfitSell';
import type { HoldingItem } from '../shared/types';

type AutoMode = 'off' | 'dryrun' | 'semi' | 'auto';
type AutoActionKind = 'BUY' | 'TP' | 'SL'; // 매수 / 익절 매도 / 손절 매도

// 로그 라벨용 단가 표기. 저가주 정밀도 보존 위해 2~4자리($ 없이 숫자만).
function fmtPrice(value: number) {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

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
  /** 주문 가능 금액 — 자동매수 1회 금액 상한(10%) 계산에 사용 */
  buyingPower?: number;
  /** 주문 제출 중 — 실행 버튼 비활성 */
  submitting?: boolean;
  /** 실제 주문 실행(세미오토 '실행' 탭 시). OrderForm 의 검증된 제출 경로 재사용. */
  onAutoExecute: (side: 'BUY' | 'SELL', quantity: number, limitPrice?: number) => void;
  /** 세미오토/오토(실주문 모드) 활성 여부 변경 알림 — OrderForm 이 주문 입력 영역을 숨기는 데 사용. */
  onExecModeChange?: (active: boolean) => void;
  /** 모바일(좁은 폭) 여부 — 화면 꺼짐/백그라운드 시 멈춤 안내를 노출하기 위함. */
  isMobile?: boolean;
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
const COOLDOWN_MS = 30_000; // 연속 실행 최소 간격(오토). 손절 반응성을 위해 60→30s 로 단축.
// 트리거 재기록 정책: 같은 종류(매수/익절/손절) 신호는 "의미 있는 변동"이 있을 때만 다시 올린다.
// - 최소 간격(MIN_RELOG_MS) 안에선 무조건 억제(도배 방지 바닥)
// - 그 뒤엔 직전 기록 대비 진입가가 PRICE_RELOG_PCT 이상 움직이거나 수량이 바뀌면 즉시 갱신
// - 신호가 사라졌다(조건 false) 다시 켜지면 새 에피소드로 즉시 기록
const MIN_RELOG_MS = 30_000;
const PRICE_RELOG_PCT = 0.3;
const DAILY_LIMIT_DEFAULT = 10;
const STOP_LOSS_DEFAULT = 2;
const TARGET_DEFAULT = 3;
// 자동매수 1회 최대 금액 = 주문가능금액(buyingPower)의 이 비율(%). 과대 매수 방지.
const AUTO_BUY_MAX_PCT = 5;
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
 * 자동매매 패널 (1~3단계 통합).
 *  - OFF: 비활성(킬 스위치)
 *  - 드라이런: 추천 매수·익절/손절 신호를 감지해 "했을 주문"을 기록만(실주문 X)
 *  - 세미오토: 트리거 시 대기 카드 노출 → 사용자가 '실행' 탭해야 실제 주문(확인 탭 필수)
 *  - 오토: 트리거 + 가드 통과 시 확인 없이 자동 실주문(켤 때 확인, 탭 숨김 시 일시정지)
 *
 * 안전장치: 킬 스위치(모드 OFF) · 손절률 · 일일 실행 한도 · 쿨다운 · 탭 가시성(오토) ·
 * 종목당 단일 대기(세미) · 감사로그. 데스크탑·모바일 모두 동작하되, 렌더+포그라운드(탭 보임)
 * 상태에서만 트리거가 돈다(탭 숨김 시 오토 일시정지). 모바일은 화면 꺼짐 방지 권장.
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
  buyingPower,
  submitting,
  onAutoExecute,
  onExecModeChange,
  isMobile = false,
}: AutoTradePanelProps) {
  const [mode, setMode] = useState<AutoMode>('off');
  // 자동매도 목표 수익률(실수익률 %) — 자동매매 전용 입력. 주문폼 선택값으로 초기화 후 독립 관리.
  const [targetPercent, setTargetPercent] = useState(() =>
    takeProfitRatePercent && takeProfitRatePercent > 0 ? takeProfitRatePercent : TARGET_DEFAULT
  );
  const [stopLossPercent, setStopLossPercent] = useState(STOP_LOSS_DEFAULT);
  const [dailyLimit, setDailyLimit] = useState(DAILY_LIMIT_DEFAULT);
  const [dailyCount, setDailyCount] = useState(() => readDailyCount());
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [pending, setPending] = useState<PendingAction | null>(null);

  const pendingRef = useRef<PendingAction | null>(null);
  const lastExecRef = useRef(0);
  // 종류별 마지막 기록 스냅샷(가격·수량·시각). 의미 있는 변동 판정 + 도배 억제에 사용.
  // 조건이 false(신호 사라짐)면 null 로 리셋해, 다시 켜질 때 새 에피소드로 즉시 기록.
  const lastSignalRef = useRef<Record<AutoActionKind, { price: number; qty: number; time: number } | null>>(
    { BUY: null, TP: null, SL: null }
  );
  pendingRef.current = pending;

  // 탭 가시성 — 오토는 탭이 보일 때만 자동 실행(직접 감시 전제). 가리면 일시정지.
  const [isTabVisible, setIsTabVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible'
  );
  const isTabVisibleRef = useRef(isTabVisible);
  isTabVisibleRef.current = isTabVisible;
  useEffect(() => {
    const onVis = () => setIsTabVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // '?' 설명 툴팁 — order-column 이 overflow:hidden 이라 절대위치로는 잘린다.
  // position:fixed + 트리거 좌표로 띄워 오버플로 밖으로 렌더(우측 넘침은 뷰포트로 클램프).
  const helpRef = useRef<HTMLButtonElement>(null);
  const [tipPos, setTipPos] = useState<{ top: number; left: number } | null>(null);
  const TIP_WIDTH = 260;
  const openTip = () => {
    const r = helpRef.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - TIP_WIDTH - 8));
    setTipPos({ top: r.bottom + 6, left });
  };
  const closeTip = () => setTipPos(null);

  // 오토 모드 켜기는 실수 방지를 위해 명시적 확인을 받는다.
  const selectMode = (next: AutoMode) => {
    if (next === mode) return;
    if (next === 'auto') {
      const ok =
        typeof window !== 'undefined' &&
        window.confirm(
          '오토 모드를 켭니다.\n트리거 발생 시 확인 없이 자동으로 실제 주문이 나갑니다(취소 없음).\n탭을 가리면 일시정지되고, 끄려면 OFF 를 누르면 됩니다.\n계속할까요?'
        );
      if (!ok) return;
    }
    setMode(next);
  };

  useEffect(() => {
    lastSignalRef.current = { BUY: null, TP: null, SL: null };
    setPending(null);
  }, [symbol]);

  // 세미오토/오토(실주문 모드) 활성 여부를 부모에 알린다(주문 입력 영역 숨김용). 언마운트 시 해제.
  useEffect(() => {
    onExecModeChange?.(mode === 'semi' || mode === 'auto');
    return () => onExecModeChange?.(false);
  }, [mode, onExecModeChange]);

  // 의미 있는 변동인지 판정: 첫 감지면 즉시, 최소 간격 내면 억제, 그 뒤엔 가격 변동률/수량 변화로 결정.
  const shouldFire = (kind: AutoActionKind, price: number, qty: number) => {
    const last = lastSignalRef.current[kind];
    if (!last) return true;
    if (Date.now() - last.time < MIN_RELOG_MS) return false;
    const priceMoved =
      last.price > 0 && (Math.abs(price - last.price) / last.price) * 100 >= PRICE_RELOG_PCT;
    return priceMoved || qty !== last.qty;
  };

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
          targetPercent,
          getTakeProfitCostContext(holding)
        )
      : undefined;
  const tpReached = tpPrice !== undefined && currentPrice !== undefined && currentPrice >= tpPrice;

  const slPrice =
    hasPosition && holding!.averagePrice
      ? holding!.averagePrice * (1 - stopLossPercent / 100)
      : undefined;
  const slReached = slPrice !== undefined && currentPrice !== undefined && currentPrice <= slPrice;

  // 자동매수 1회 금액 상한: 주문가능금액의 AUTO_BUY_MAX_PCT% 이내로 수량을 제한.
  const buyAmountCapQty =
    buyingPower !== undefined && buyEntryPrice !== undefined && buyEntryPrice > 0
      ? Math.floor((buyingPower * (AUTO_BUY_MAX_PCT / 100)) / buyEntryPrice)
      : undefined;
  // 추천 수량과 금액 상한 중 작은 값. 상한 계산 가능 시 그 값을 적용(0이면 매수 불가).
  const effectiveBuyQty =
    buyQuantity !== undefined
      ? buyAmountCapQty !== undefined
        ? Math.min(buyQuantity, buyAmountCapQty)
        : buyQuantity
      : undefined;

  const buyReady =
    buyRecommended &&
    effectiveBuyQty !== undefined &&
    effectiveBuyQty > 0 &&
    buyEntryPrice !== undefined &&
    buyEntryPrice > 0;

  // 매수 진입가 기준 목표 매도가(자동매매 목표 수익률 적용) — 매수 트리거 라벨 표시용.
  const buyTargetSell =
    buyReady && buyEntryPrice !== undefined && effectiveBuyQty !== undefined
      ? calculateTakeProfitSellPrice(buyEntryPrice, effectiveBuyQty, targetPercent)
      : undefined;

  const active = mode !== 'off';

  // 실제 주문 실행 + 공통 가드(제출 중·일일 한도·쿨다운). 통과해 주문을 내면 true.
  const runExecute = (action: PendingAction): boolean => {
    if (submitting) return false;
    const count = readDailyCount();
    if (count >= dailyLimit) {
      pushLog('block', action.side, `차단(일일 한도 ${dailyLimit}회 초과): ${action.label}`);
      return false;
    }
    // 쿨다운은 무인 자동(오토) 연사 방지용 — 사람이 직접 누르는 세미오토 '실행'에는 적용하지 않는다.
    if (mode === 'auto' && Date.now() - lastExecRef.current < COOLDOWN_MS) {
      const wait = Math.ceil((COOLDOWN_MS - (Date.now() - lastExecRef.current)) / 1000);
      pushLog('block', action.side, `차단(쿨다운 ${wait}s 남음): ${action.label}`);
      return false;
    }
    onAutoExecute(action.side, action.quantity, action.limitPrice);
    lastExecRef.current = Date.now();
    const next = count + 1;
    writeDailyCount(next);
    setDailyCount(next);
    pushLog('exec', action.side, `실행: ${action.label}`);
    return true;
  };

  // 트리거 처리: 드라이런=기록만, 세미오토=대기 카드, 오토=가드 통과 시 즉시 실행.
  // shouldFire 로 의미 있는 변동일 때만 호출된다. 발생 시 스냅샷(가격·수량·시각) 갱신.
  const fireTrigger = (
    action: PendingAction,
    dryRunText: string,
    snapPrice: number,
    snapQty: number
  ) => {
    const snap = { price: snapPrice, qty: snapQty, time: Date.now() };
    if (mode === 'dryrun') {
      lastSignalRef.current[action.kind] = snap;
      pushLog('trigger', action.side, dryRunText);
      return;
    }
    if (mode === 'auto') {
      // 탭이 가려져 있으면 자동 실행 일시정지(스냅샷 갱신 안 함 → 다시 보이면 곧 실행).
      if (!isTabVisibleRef.current) {
        pushLog('block', action.side, `자동 일시정지(탭 숨김): ${action.label}`);
        return;
      }
      lastSignalRef.current[action.kind] = snap;
      pushLog('trigger', action.side, `자동 실행 트리거: ${action.label}`);
      runExecute(action); // 가드 통과 시 즉시 주문, 실패 시 block 로그
      return;
    }
    // semi: 이미 대기 중이면 새로 만들지 않음(스냅샷도 갱신 안 함 → 대기 해소 후 다음 변동 반영).
    if (pendingRef.current) return;
    lastSignalRef.current[action.kind] = snap;
    pendingRef.current = action;
    setPending(action);
    pushLog('trigger', action.side, `대기: ${action.label} — '실행'을 눌러야 주문됩니다`);
  };

  // 매수 트리거
  useEffect(() => {
    if (!active) return;
    if (buyReady) {
      if (shouldFire('BUY', buyEntryPrice!, effectiveBuyQty!)) {
        const label = `매수 ${symbol} ${effectiveBuyQty}주 @ $${fmtPrice(buyEntryPrice!)}${buyTargetSell !== undefined ? ` → 목표 $${fmtPrice(buyTargetSell)} (+${targetPercent}%)` : ''}`;
        fireTrigger(
          { id: crypto.randomUUID(), kind: 'BUY', side: 'BUY', quantity: effectiveBuyQty!, limitPrice: buyEntryPrice, label },
          `모의 ${label}`,
          buyEntryPrice!,
          effectiveBuyQty!
        );
      }
    } else {
      lastSignalRef.current.BUY = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, mode, isTabVisible, buyReady, symbol, effectiveBuyQty, buyEntryPrice, buyTargetSell, targetPercent]);

  // 익절 매도 트리거
  useEffect(() => {
    if (!active) return;
    if (tpReached && sellQty !== undefined && currentPrice !== undefined) {
      if (shouldFire('TP', currentPrice, sellQty)) {
        const label = `익절 매도(전량) ${symbol} ${sellQty}주 @ $${fmtPrice(currentPrice)} (목표 +${targetPercent}%)`;
        fireTrigger(
          { id: crypto.randomUUID(), kind: 'TP', side: 'SELL', quantity: sellQty, limitPrice: currentPrice, label },
          `모의 ${label}`,
          currentPrice,
          sellQty
        );
      }
    } else {
      lastSignalRef.current.TP = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, mode, isTabVisible, tpReached, sellQty, currentPrice, symbol, targetPercent]);

  // 손절 매도 트리거
  useEffect(() => {
    if (!active) return;
    if (slReached && sellQty !== undefined && currentPrice !== undefined) {
      if (shouldFire('SL', currentPrice, sellQty)) {
        const label = `손절 매도(전량) ${symbol} ${sellQty}주 @ $${fmtPrice(currentPrice)} (손절 -${stopLossPercent}%)`;
        fireTrigger(
          { id: crypto.randomUUID(), kind: 'SL', side: 'SELL', quantity: sellQty, limitPrice: currentPrice, label },
          `모의 ${label}`,
          currentPrice,
          sellQty
        );
      }
    } else {
      lastSignalRef.current.SL = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, mode, isTabVisible, slReached, sellQty, currentPrice, symbol, stopLossPercent]);

  const dismissPending = () => {
    if (pending) pushLog('skip', pending.side, `무시: ${pending.label}`);
    pendingRef.current = null;
    setPending(null);
  };

  const executePending = () => {
    if (!pending || mode !== 'semi') return; // 킬 스위치
    if (runExecute(pending)) {
      pendingRef.current = null;
      setPending(null);
    }
  };

  const limitReached = dailyCount >= dailyLimit;

  return (
    <div className={`auto-trade ${active ? 'is-active' : ''}`}>
      <div className="auto-trade__head">
        <span className="auto-trade__title">
          자동매매
          <span className="auto-trade__help">
            <button
              type="button"
              ref={helpRef}
              className="auto-trade__help-trigger"
              aria-label="자동매매 설명"
              onMouseEnter={openTip}
              onMouseLeave={closeTip}
              onFocus={openTip}
              onBlur={closeTip}
            >
              ?
            </button>
          </span>
        </span>
        <div className="auto-trade__modes" role="tablist">
          {(['off', 'dryrun', 'semi', 'auto'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={`auto-trade__mode ${mode === m ? 'is-on' : ''}${m === 'auto' ? ' is-auto' : ''}`}
              onClick={() => selectMode(m)}
            >
              {m === 'off' ? 'OFF' : m === 'dryrun' ? '드라이런' : m === 'semi' ? '세미오토' : '오토'}
            </button>
          ))}
        </div>
      </div>

      <div className="auto-trade__controls">
        <label className="auto-trade__field">
          목표 수익률
          <input
            type="number"
            min={0.1}
            step={0.1}
            value={targetPercent}
            onChange={(e) => setTargetPercent(Math.max(0.1, Number(e.target.value) || 0))}
          />
          %
        </label>
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

      {isMobile && active && (
        <p className="auto-trade__mobile-hint">
          📱 모바일에선 화면이 꺼지거나 앱을 벗어나면 자동 실행이 멈춰요. 상단 👁(화면 꺼짐 방지)를
          켜고 이 화면을 포그라운드로 유지하세요.
        </p>
      )}

      {mode === 'auto' && !isTabVisible && (
        <p className="auto-trade__paused">⏸ 탭이 가려져 자동 실행 일시정지 중 — 이 탭을 다시 보면 재개됩니다.</p>
      )}

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

      {tipPos && (
        <div
          className="auto-trade__tip"
          role="tooltip"
          style={{ position: 'fixed', top: tipPos.top, left: tipPos.left, width: TIP_WIDTH }}
        >
          <b>드라이런</b> 모의 기록만(실주문 없음)
          <br />
          <b>세미오토</b> 트리거 시 “실행” 탭해야 실주문
          <br />
          <b>오토</b> 트리거 시 확인 없이 자동 실주문
          <br />
          익절=목표 도달, 손절=손절률 도달 시 전량 매도. 일일 한도·쿨다운(30s)·탭 숨김 일시정지로
          보호. 현재 종목만. 모바일은 앱을 포그라운드로 유지(화면 꺼짐 방지 권장)해야 동작.
        </div>
      )}
    </div>
  );
}

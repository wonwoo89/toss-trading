import { useEffect, useRef, useState } from 'react';
import { NumberField } from './NumberField';
import { Button } from '../shared/ui/Button';
import { SegmentedControl } from '../shared/ui/SegmentedControl';
import {
  calculateTakeProfitSellPrice,
  getTakeProfitCostContext,
} from '../shared/lib/takeProfitSell';
import { usdMaxFractionDigits } from '../shared/lib/formatHoldings';
import { buildChartSignalSnapshot } from '../shared/lib/chartSignals';
import { computeCandleTrend } from '../shared/lib/candleTrend';
import {
  addDailyRealizedUsd,
  getAutoTradeSettings,
  getDailyRealizedUsd,
  loadAutoTradeLogs,
  saveAutoTradeLogs,
  saveAutoTradeSettings,
  type AutoTradeMode,
} from '../shared/lib/autoTradeSettings';
import { api, type AiDecision } from '../shared/api/client';
import type { ChartCandle, HoldingItem, Order } from '../shared/types';

type AutoActionKind = 'BUY' | 'TP' | 'SL' | 'TS'; // 매수 / 익절 매도 / 손절 매도 / 트레일링 스탑 매도

// 로그 라벨용 단가 표기. $1 미만만 2~4자리(저가주 정밀도), $1 이상은 2자리($ 없이 숫자만).
function fmtPrice(value: number) {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: usdMaxFractionDigits(value),
  });
}

interface AutoTradePanelProps {
  symbol: string;
  currentPrice?: number;
  holding?: HoldingItem;
  /** 매도 가능 수량(effectiveSellableQuantity) */
  sellableQuantity?: number;
  takeProfitRatePercent: number;
  /** 주문 가능 금액 — AI 매수 1회 금액 상한 계산에 사용 */
  buyingPower?: number;
  /** 주문 제출 중 — 실행 버튼 비활성 */
  submitting?: boolean;
  /** 실제 주문 실행(세미오토 '실행' 탭 시). OrderForm 의 검증된 제출 경로 재사용. */
  onAutoExecute: (side: 'BUY' | 'SELL', quantity: number, limitPrice?: number) => void;
  /** 세미오토/오토(실주문 모드) 활성 여부 변경 알림 — OrderForm 이 주문 입력 영역을 숨기는 데 사용. */
  onExecModeChange?: (active: boolean) => void;
  /** 모바일(좁은 폭) 여부 — 화면 꺼짐/백그라운드 시 멈춤 안내를 노출하기 위함. */
  isMobile?: boolean;
  // AI(LLM) 판단용 추가 입력. 봉 마감·의미있는 변동 시 서버로 스냅샷을 보내 BUY/SELL/HOLD 를 받는다.
  candles?: ChartCandle[];
  candleInterval?: string;
  bids?: { price: number; quantity: number }[];
  asks?: { price: number; quantity: number }[];
  previousClose?: number;
  maxBuyQuantity?: number;
  /** 이 종목의 미체결 주문 — AI 페이로드(중복 진입/청산 회피)에 사용. */
  openOrders?: Order[];
  currency?: string;
}

interface LogEntry {
  id: string;
  time: string;
  level: 'trigger' | 'exec' | 'skip' | 'block';
  side: 'BUY' | 'SELL';
  symbol: string;
  text: string;
}

interface PendingAction {
  id: string;
  kind: AutoActionKind;
  side: 'BUY' | 'SELL';
  quantity: number;
  limitPrice?: number;
  label: string;
  /** AI 판단에서 만들어진 액션이면 해당 이력 항목 id — 실행 시 executed 표시용. */
  aiHistoryId?: string;
}

/** AI 판단 이력 항목 — 화면 표시 + 다음 판단 페이로드(일관성 컨텍스트)에 사용. */
interface AiHistoryEntry {
  id: string;
  t: number; // epoch ms
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  reason: string;
  executed: boolean;
}

const MAX_LOG = 40;
const MAX_AI_HISTORY = 10;
const COOLDOWN_MS = 30_000; // 연속 실행 최소 간격(오토). 손절 반응성을 위해 60→30s 로 단축.
// 트리거 재기록 정책: 같은 종류(익절/손절/트레일링) 신호는 "의미 있는 변동"이 있을 때만 다시 올린다.
// - 최소 간격(MIN_RELOG_MS) 안에선 무조건 억제(도배 방지 바닥)
// - 그 뒤엔 직전 기록 대비 진입가가 PRICE_RELOG_PCT 이상 움직이거나 수량이 바뀌면 즉시 갱신
// - 신호가 사라졌다(조건 false) 다시 켜지면 새 에피소드로 즉시 기록
const MIN_RELOG_MS = 30_000;
const PRICE_RELOG_PCT = 0.3;
// AI 판단 호출 최소 간격(과호출·비용 방지) + 봉 마감 외 추가 호출 임계(의미있는 가격 변동 %).
const AI_MIN_INTERVAL_MS = 20_000;
const AI_PRICE_MOVE_PCT = 0.3;

/**
 * 자동매매 패널.
 *  - OFF: 비활성(킬 스위치)
 *  - 드라이런: AI 판단·익절/손절/트레일링 신호를 감지해 "했을 주문"을 기록만(실주문 X)
 *  - 세미오토: 트리거 시 대기 카드 노출 → 사용자가 '실행' 탭해야 실제 주문(확인 탭 필수)
 *  - 오토: 트리거 + 가드 통과 시 확인 없이 자동 실주문(켤 때 확인, 탭 숨김 시 일시정지)
 *
 * 매수 진입은 AI 판단(useAi)으로만 이루어지고, 익절/손절/트레일링 보호 매도는 항상 동작한다.
 * 설정(모드·비율·한도)과 로그는 localStorage 에 영속돼 새로고침 후에도 유지된다.
 *
 * 안전장치: 킬 스위치(모드 OFF) · 손절률 · 트레일링 스탑 · 일일 손실 한도(도달 시 강제 OFF) ·
 * 쿨다운 · 탭 가시성(오토) · 종목당 단일 대기(세미) · 감사로그. 데스크탑·모바일 모두 동작하되,
 * 렌더+포그라운드(탭 보임) 상태에서만 트리거가 돈다(탭 숨김 시 오토 일시정지).
 */
export function AutoTradePanel({
  symbol,
  currentPrice,
  holding,
  sellableQuantity,
  takeProfitRatePercent,
  buyingPower,
  submitting,
  onAutoExecute,
  onExecModeChange,
  isMobile = false,
  candles = [],
  candleInterval = '1m',
  bids = [],
  asks = [],
  previousClose,
  maxBuyQuantity,
  openOrders = [],
  currency = 'USD',
}: AutoTradePanelProps) {
  // 설정은 localStorage 에서 복원(모바일 PWA 재시작 후에도 유지). 변경 시 즉시 저장.
  const [initialSettings] = useState(getAutoTradeSettings);
  const [mode, setMode] = useState<AutoTradeMode>(initialSettings.mode);
  const [targetPercent, setTargetPercent] = useState(() =>
    takeProfitRatePercent && takeProfitRatePercent > 0
      ? takeProfitRatePercent
      : initialSettings.targetPercent
  );
  const [stopLossPercent, setStopLossPercent] = useState(initialSettings.stopLossPercent);
  const [trailingStopPercent, setTrailingStopPercent] = useState(
    initialSettings.trailingStopPercent
  );
  const [buyMaxPercent, setBuyMaxPercent] = useState(initialSettings.buyMaxPercent);
  const [dailyLossLimitUsd, setDailyLossLimitUsd] = useState(initialSettings.dailyLossLimitUsd);
  const [useAi, setUseAi] = useState(initialSettings.useAi);
  const [dailyRealizedUsd, setDailyRealizedUsd] = useState(getDailyRealizedUsd);

  const [logs, setLogs] = useState<LogEntry[]>(loadAutoTradeLogs);
  const [pending, setPending] = useState<PendingAction | null>(null);

  // AI(LLM) 판단: 봉 마감·의미있는 변동 시 서버에 스냅샷을 보내 BUY/SELL/HOLD 를 받아 실행한다.
  // 안전: 손절/쿨다운/탭가시성/킬스위치 등 가드는 그대로 적용되고, AI 는 그 안에서 '방향'만 정한다.
  const [aiDecision, setAiDecision] = useState<AiDecision | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiHistory, setAiHistory] = useState<AiHistoryEntry[]>([]);
  const aiHistoryRef = useRef<AiHistoryEntry[]>([]);
  const aiInFlightRef = useRef(false);
  const aiLastCallRef = useRef(0);
  const aiLastClosedKeyRef = useRef<number | null>(null);
  const aiLastPriceRef = useRef<number | null>(null);

  const pendingRef = useRef<PendingAction | null>(null);
  const lastExecRef = useRef(0);
  // 종류별 마지막 기록 스냅샷(가격·수량·시각). 의미 있는 변동 판정 + 도배 억제에 사용.
  // 조건이 false(신호 사라짐)면 null 로 리셋해, 다시 켜질 때 새 에피소드로 즉시 기록.
  const lastSignalRef = useRef<
    Record<AutoActionKind, { price: number; qty: number; time: number } | null>
  >({ BUY: null, TP: null, SL: null, TS: null });
  // 트레일링 스탑 고점 추적 — 포지션 관찰 시작 이후의 최고가(초기값은 max(평단, 현재가)).
  const trailPeakRef = useRef<number | null>(null);
  pendingRef.current = pending;

  // 설정 영속화 — 어떤 값이든 바뀌면 저장.
  useEffect(() => {
    saveAutoTradeSettings({
      mode,
      useAi,
      targetPercent,
      stopLossPercent,
      trailingStopPercent,
      buyMaxPercent,
      dailyLossLimitUsd,
    });
  }, [mode, useAi, targetPercent, stopLossPercent, trailingStopPercent, buyMaxPercent, dailyLossLimitUsd]);

  // 로그 영속화 — 새로고침 후에도 감사 기록 유지.
  useEffect(() => {
    saveAutoTradeLogs(logs);
  }, [logs]);

  // 탭 가시성 — 오토는 탭이 보일 때만 자동 실행(직접 감시 전제). 가리면 일시정지.
  const [isTabVisible, setIsTabVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible'
  );
  const isTabVisibleRef = useRef(isTabVisible);
  const wasTabVisibleRef = useRef(isTabVisible);
  isTabVisibleRef.current = isTabVisible;
  useEffect(() => {
    // 모바일은 화면 잠금 해제·앱 전환 복귀 시 visibilitychange 가 항상 발화하지 않을 수 있어
    // focus·pageshow 도 함께 듣고 document.visibilityState 로 동기화한다(복귀 누락 → 일시정지 갇힘 방지).
    const sync = () => setIsTabVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', sync);
    window.addEventListener('pageshow', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('focus', sync);
      window.removeEventListener('pageshow', sync);
    };
  }, []);

  // 백그라운드→복귀(숨김→보임) 시: 보호 매도(익절·손절·트레일링) 스냅샷을 비워 조건이 여전히
  // 충족되면 즉시 재평가·실행(일시정지 동안 놓친 출구 신호 즉시 반영). 매수는 의도치 않은
  // 재매수 방지 위해 기존 dedup 경로를 그대로 따른다.
  useEffect(() => {
    if (isTabVisible && !wasTabVisibleRef.current) {
      lastSignalRef.current.TP = null;
      lastSignalRef.current.SL = null;
      lastSignalRef.current.TS = null;
    }
    wasTabVisibleRef.current = isTabVisible;
  }, [isTabVisible]);

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
  const selectMode = (next: AutoTradeMode) => {
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
    lastSignalRef.current = { BUY: null, TP: null, SL: null, TS: null };
    trailPeakRef.current = null;
    setPending(null);
    setAiDecision(null);
    setAiHistory([]);
    aiHistoryRef.current = [];
    aiLastClosedKeyRef.current = null;
    aiLastPriceRef.current = null;
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
        {
          id: crypto.randomUUID(),
          time: new Date().toLocaleTimeString('ko-KR'),
          level,
          side,
          symbol,
          text,
        },
        ...prev,
      ].slice(0, MAX_LOG)
    );
  };

  // 저장된 모드가 실주문 모드(세미/오토)로 복원됐음을 로그로 남긴다(1회).
  const restoredNoticeRef = useRef(false);
  useEffect(() => {
    if (restoredNoticeRef.current) return;
    restoredNoticeRef.current = true;
    if (initialSettings.mode === 'auto' || initialSettings.mode === 'semi') {
      pushLog(
        'trigger',
        'BUY',
        `설정 복원: ${initialSettings.mode === 'auto' ? '오토' : '세미오토'} 모드로 재시작됨 (끄려면 OFF)`
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const active = mode !== 'off';
  const dailyLossReached = dailyLossLimitUsd > 0 && dailyRealizedUsd <= -dailyLossLimitUsd;

  // 실제 주문 실행 + 공통 가드(제출 중·쿨다운·일일 손실 한도). 통과해 주문을 내면 true.
  const runExecute = (action: PendingAction): boolean => {
    if (submitting) return false;
    // 일일 손실 한도 도달 시 신규 매수 차단(보호 매도는 허용).
    if (action.side === 'BUY' && dailyLossLimitUsd > 0 && getDailyRealizedUsd() <= -dailyLossLimitUsd) {
      pushLog('block', 'BUY', `차단(일일 손실 한도 도달): ${action.label}`);
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
    pushLog('exec', action.side, `실행: ${action.label}`);

    // 매도 실행 시 실현 손익을 일일 원장에 누적. 한도 도달 시 자동매매 강제 OFF(킬 스위치).
    if (
      action.side === 'SELL' &&
      action.limitPrice !== undefined &&
      holding?.averagePrice !== undefined &&
      holding.averagePrice > 0
    ) {
      const realized = (action.limitPrice - holding.averagePrice) * action.quantity;
      const total = addDailyRealizedUsd(realized);
      setDailyRealizedUsd(total);
      if (dailyLossLimitUsd > 0 && total <= -dailyLossLimitUsd) {
        setMode('off');
        pushLog(
          'block',
          'SELL',
          `일일 손실 한도 도달($${total.toFixed(2)} ≤ -$${dailyLossLimitUsd}) — 자동매매 OFF`
        );
      }
    }
    // AI 판단에서 만들어진 액션이면 이력에 '실행됨' 표시.
    if (action.aiHistoryId) markAiHistoryExecuted(action.aiHistoryId);
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

  // 트레일링 스탑 — 포지션 보유 중 최고가를 추적하고, 고점 대비 설정 % 이상 하락 시 전량 매도.
  // 고점 추적·판정 모두 effect 안에서 수행(렌더 중 ref 접근 금지). 모드 OFF 여도 고점은 계속
  // 추적해, 켜는 순간 그동안의 고점 기준으로 동작한다. 고점 초기값은 max(평단, 현재가).
  useEffect(() => {
    if (hasPosition && currentPrice !== undefined && currentPrice > 0) {
      const base = trailPeakRef.current ?? Math.max(holding!.averagePrice!, currentPrice);
      trailPeakRef.current = Math.max(base, currentPrice);
    } else if (!hasPosition) {
      trailPeakRef.current = null;
    }

    if (!active) return;
    const trailPeak = trailPeakRef.current;
    const trailStopPrice =
      trailingStopPercent > 0 && trailPeak !== null
        ? trailPeak * (1 - trailingStopPercent / 100)
        : undefined;
    const tsReached =
      trailStopPrice !== undefined &&
      currentPrice !== undefined &&
      currentPrice <= trailStopPrice &&
      // 익절/손절이 이미 발화하는 상황이면 그 트리거에 맡긴다(중복 매도 방지).
      !tpReached &&
      !slReached;

    if (tsReached && sellQty !== undefined && currentPrice !== undefined && trailPeak !== null) {
      if (shouldFire('TS', currentPrice, sellQty)) {
        const label = `트레일링 매도(전량) ${symbol} ${sellQty}주 @ $${fmtPrice(currentPrice)} (고점 $${fmtPrice(trailPeak)} 대비 -${trailingStopPercent}%)`;
        fireTrigger(
          { id: crypto.randomUUID(), kind: 'TS', side: 'SELL', quantity: sellQty, limitPrice: currentPrice, label },
          `모의 ${label}`,
          currentPrice,
          sellQty
        );
      }
    } else {
      lastSignalRef.current.TS = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, mode, isTabVisible, hasPosition, tpReached, slReached, sellQty, currentPrice, symbol, trailingStopPercent]);

  // ── AI 판단 이력 관리 ─────────────────────────────────────────
  const pushAiHistory = (decision: AiDecision): string => {
    const entry: AiHistoryEntry = {
      id: crypto.randomUUID(),
      t: Date.now(),
      action: decision.action,
      confidence: decision.confidence,
      reason: decision.reason,
      executed: false,
    };
    const next = [entry, ...aiHistoryRef.current].slice(0, MAX_AI_HISTORY);
    aiHistoryRef.current = next;
    setAiHistory(next);
    return entry.id;
  };

  const markAiHistoryExecuted = (id: string) => {
    const next = aiHistoryRef.current.map((h) => (h.id === id ? { ...h, executed: true } : h));
    aiHistoryRef.current = next;
    setAiHistory(next);
  };

  // AI 결정 실행: BUY/SELL 을 기존 모드 정책(드라이런=기록, 세미=대기, 오토=즉시)·가드로 라우팅.
  const executeAiDecision = (decision: AiDecision, historyId: string) => {
    if (mode === 'off') return;
    if (decision.action === 'HOLD' || decision.fallback) {
      if (mode === 'dryrun') {
        pushLog('skip', 'BUY', `AI 관망: ${decision.reason || '근거 없음'}`);
      }
      return;
    }

    let action: PendingAction;
    if (decision.action === 'BUY') {
      // AI 매수 수량: AI 제안 비중(sizePct)을 존중하되 사용자 상한(buyMaxPercent)으로 캡.
      const price = currentPrice;
      if (price === undefined || price <= 0 || buyingPower === undefined || buyingPower <= 0) {
        pushLog('block', 'BUY', `AI 매수 보류 — 가격/주문가능 부족: ${decision.reason}`);
        return;
      }
      const effectivePct =
        decision.sizePct > 0 ? Math.min(decision.sizePct, buyMaxPercent) : buyMaxPercent;
      let qty = Math.floor((buyingPower * (effectivePct / 100)) / price);
      if (maxBuyQuantity !== undefined) qty = Math.min(qty, maxBuyQuantity);
      if (qty <= 0) {
        pushLog('block', 'BUY', `AI 매수 보류 — 수량 0(주문가능 부족): ${decision.reason}`);
        return;
      }
      action = {
        id: crypto.randomUUID(),
        kind: 'BUY',
        side: 'BUY',
        quantity: qty,
        limitPrice: price,
        label: `AI 매수 ${symbol} ${qty}주(비중 ${effectivePct}%) @ $${fmtPrice(price)} — ${decision.reason}`,
        aiHistoryId: historyId,
      };
    } else {
      // SELL: 보유분 전량 청산 제안. (TP/SL 보호와 별개의 재량 매도)
      if (sellQty === undefined || sellQty <= 0 || currentPrice === undefined) {
        pushLog('block', 'SELL', `AI 매도 보류 — 보유 없음: ${decision.reason}`);
        return;
      }
      action = {
        id: crypto.randomUUID(),
        kind: 'TP',
        side: 'SELL',
        quantity: sellQty,
        limitPrice: currentPrice,
        label: `AI 매도(전량) ${symbol} ${sellQty}주 @ $${fmtPrice(currentPrice)} — ${decision.reason}`,
        aiHistoryId: historyId,
      };
    }

    if (mode === 'dryrun') {
      pushLog('trigger', action.side, `모의 ${action.label}`);
      return;
    }
    if (mode === 'auto') {
      if (!isTabVisibleRef.current) {
        pushLog('block', action.side, `자동 일시정지(탭 숨김): ${action.label}`);
        return;
      }
      pushLog('trigger', action.side, `AI 자동 실행: ${action.label}`);
      runExecute(action);
      return;
    }
    // semi: 종목당 단일 대기
    if (pendingRef.current) return;
    pendingRef.current = action;
    setPending(action);
    pushLog('trigger', action.side, `AI 대기: ${action.label} — '실행'을 눌러야 주문됩니다`);
  };

  // AI 트리거: 봉 마감(완성봉 변경) 또는 의미있는 가격 변동 시(최소 간격 내 억제) 서버에 판단 요청.
  useEffect(() => {
    if (!useAi || !active) return;
    if (candles.length < 2 || currentPrice === undefined || currentPrice <= 0) return;

    const sorted = candles.slice().sort((a, b) => a.time - b.time);
    const closedKey = sorted[sorted.length - 2]?.time ?? null; // 마지막은 형성 중 → 직전 완성봉
    const now = Date.now();
    const newBar = closedKey !== null && closedKey !== aiLastClosedKeyRef.current;
    const lastP = aiLastPriceRef.current;
    const moved =
      lastP !== null && lastP > 0 && (Math.abs(currentPrice - lastP) / lastP) * 100 >= AI_PRICE_MOVE_PCT;
    const intervalOk = now - aiLastCallRef.current >= AI_MIN_INTERVAL_MS;

    if (aiInFlightRef.current) return;
    if (!(newBar || (moved && intervalOk))) return;
    if (!intervalOk && !newBar) return;

    aiInFlightRef.current = true;
    aiLastCallRef.current = now;
    aiLastClosedKeyRef.current = closedKey;
    aiLastPriceRef.current = currentPrice;
    setAiLoading(true);

    const signal = buildChartSignalSnapshot({ candles: sorted, bids, asks });
    const trend = computeCandleTrend(sorted);
    const recent = sorted.slice(-40).map((c) => ({
      t: c.time,
      o: c.open,
      h: c.high,
      l: c.low,
      c: c.close,
      v: c.volume,
    }));
    const bidTotal = bids.reduce((s, b) => s + b.quantity, 0);
    const askTotal = asks.reduce((s, a) => s + a.quantity, 0);
    const dayChangePct =
      previousClose && previousClose > 0
        ? ((currentPrice - previousClose) / previousClose) * 100
        : undefined;
    // 미체결 주문(이 종목) 요약 — 중복 진입/청산 회피 컨텍스트.
    const openOrderSummary = openOrders
      .filter((o) => o.symbol?.toUpperCase() === symbol.toUpperCase())
      .slice(0, 10)
      .map((o) => ({ side: o.side, price: o.price, quantity: o.quantity }));
    // 직전 판단 이력(최근→과거) — 일관성 있는 연속 판단 컨텍스트.
    const history = aiHistoryRef.current.slice(0, 8).map((h) => ({
      t: h.t,
      action: h.action,
      confidence: h.confidence,
      executed: h.executed,
      reason: h.reason.slice(0, 100),
    }));

    void api
      .getAiDecision({
        symbol,
        interval: candleInterval,
        currency,
        currentPrice,
        previousClose,
        dayChangePct,
        position:
          holding && holding.quantity > 0 && holding.averagePrice
            ? {
                quantity: holding.quantity,
                averagePrice: holding.averagePrice,
                profitLossPct:
                  holding.averagePrice > 0
                    ? ((currentPrice - holding.averagePrice) / holding.averagePrice) * 100
                    : undefined,
              }
            : undefined,
        buyingPower,
        maxBuyQuantity,
        sellableQuantity: sellQty,
        targetProfitPct: targetPercent,
        stopLossPct: stopLossPercent,
        signal: { level: signal.level, score: signal.score },
        trend: { state: trend.state, confirmedBars: trend.confirmedBars },
        orderbook: {
          bestBid: bids[0]?.price,
          bestAsk: asks[0]?.price,
          bidRatio: bidTotal + askTotal > 0 ? bidTotal / (bidTotal + askTotal) : undefined,
          bids: bids.slice(0, 5).map((l) => ({ p: l.price, q: l.quantity })),
          asks: asks.slice(0, 5).map((l) => ({ p: l.price, q: l.quantity })),
        },
        openOrders: openOrderSummary,
        history,
        guards: {
          trailingStopPct: trailingStopPercent > 0 ? trailingStopPercent : undefined,
          buyMaxPercent,
          dailyLossLimitUsd: dailyLossLimitUsd > 0 ? dailyLossLimitUsd : undefined,
          dailyRealizedUsd: dailyLossLimitUsd > 0 ? getDailyRealizedUsd() : undefined,
        },
        candles: recent,
      })
      .then((res) => {
        const decision = res.result;
        setAiDecision(decision);
        // 폴백(미설정/오류)은 이력에 남기지 않는다 — 실제 판단 흐름만 기록.
        const historyId = decision.fallback ? '' : pushAiHistory(decision);
        executeAiDecision(decision, historyId);
      })
      .catch((err: unknown) => {
        pushLog('block', 'BUY', `AI 호출 실패: ${err instanceof Error ? err.message : '오류'}`);
      })
      .finally(() => {
        aiInFlightRef.current = false;
        setAiLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useAi, active, mode, isTabVisible, candles, currentPrice]);

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

  const fmtHistoryTime = (t: number) =>
    new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

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
        <SegmentedControl
          className="auto-trade__modes"
          aria-label="자동매매 모드"
          value={mode}
          onChange={selectMode}
          options={[
            { value: 'off', label: 'OFF' },
            { value: 'dryrun', label: '드라이런' },
            { value: 'semi', label: '세미오토' },
            { value: 'auto', label: '오토', activeClassName: 'is-danger' },
          ]}
        />
      </div>

      <div className="auto-trade__controls">
        <label className="auto-trade__field">
          목표 수익률
          <NumberField min={0.1} value={targetPercent} onChange={setTargetPercent} />
          %
        </label>
        <label className="auto-trade__field">
          손절률
          <NumberField min={0.1} value={stopLossPercent} onChange={setStopLossPercent} />
          %
        </label>
        <label className="auto-trade__ai-toggle" title="AI(LLM)가 봉 마감·의미있는 변동 시 매수/매도/관망을 판단합니다. 손절·쿨다운 등 가드는 그대로 적용됩니다.">
          <input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} />
          AI 판단
        </label>
      </div>

      <div className="auto-trade__controls">
        <label className="auto-trade__field" title="포지션 고점 대비 이 % 하락 시 전량 매도(이익 보존). 0 = 끔.">
          트레일링
          <NumberField min={0} value={trailingStopPercent} onChange={setTrailingStopPercent} />
          %
        </label>
        <label className="auto-trade__field" title="AI 매수 1회 금액 상한 = 주문가능금액의 이 비율. AI 제안 비중은 이 값으로 캡됩니다.">
          1회 매수
          <NumberField min={1} max={100} value={buyMaxPercent} onChange={setBuyMaxPercent} />
          %
        </label>
        <label className="auto-trade__field" title="자동매매 실현 손실이 오늘 이 금액을 넘으면 강제 OFF. 0 = 끔.">
          일손실 $
          <NumberField min={0} value={dailyLossLimitUsd} onChange={setDailyLossLimitUsd} />
        </label>
      </div>

      {dailyLossLimitUsd > 0 && (
        <p className={`auto-trade__daily-pnl ${dailyLossReached ? 'is-limit' : ''}`}>
          오늘 자동매매 실현 손익 ${dailyRealizedUsd.toFixed(2)} / 한도 -${dailyLossLimitUsd}
          {dailyLossReached ? ' — 한도 도달(신규 매수 차단)' : ''}
        </p>
      )}

      {useAi && (
        <div className="auto-trade__ai">
          <span className="auto-trade__ai-head">
            🤖 AI {aiLoading ? '판단 중…' : aiDecision ? '' : '대기'}
          </span>
          {aiDecision && (
            <span
              className={`auto-trade__ai-decision is-${aiDecision.action.toLowerCase()}${aiDecision.fallback ? ' is-fallback' : ''}`}
            >
              {aiDecision.action === 'BUY' ? '매수' : aiDecision.action === 'SELL' ? '매도' : '관망'}
              {aiDecision.confidence ? ` ${(aiDecision.confidence * 100).toFixed(0)}%` : ''} — {aiDecision.reason}
            </span>
          )}
          {aiHistory.length > 1 && (
            <details className="auto-trade__ai-history">
              <summary>판단 이력 ({aiHistory.length})</summary>
              <ul>
                {aiHistory.map((h) => (
                  <li key={h.id} className={`is-${h.action.toLowerCase()}`}>
                    <span className="auto-trade__ai-history-time">{fmtHistoryTime(h.t)}</span>
                    <span className="auto-trade__ai-history-action">
                      {h.action === 'BUY' ? '매수' : h.action === 'SELL' ? '매도' : '관망'}
                      {h.confidence ? ` ${(h.confidence * 100).toFixed(0)}%` : ''}
                      {h.executed ? ' ✓실행' : ''}
                    </span>
                    <span className="auto-trade__ai-history-reason">{h.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

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
            {pending.kind === 'BUY'
              ? '🟢 매수 대기'
              : pending.kind === 'TP'
                ? '🔵 익절 대기'
                : pending.kind === 'TS'
                  ? '🟠 트레일링 대기'
                  : '🔴 손절 대기'}
          </span>
          <span className="auto-trade__pending-text">{pending.label}</span>
          <div className="auto-trade__pending-actions">
            <Button
              variant="accent"
              size="sm"
              className="auto-trade__exec"
              onClick={executePending}
              disabled={submitting}
            >
              실행
            </Button>
            <Button variant="ghost" size="sm" className="auto-trade__dismiss" onClick={dismissPending}>
              무시
            </Button>
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
                <span className="auto-trade__text">
                  {log.symbol && log.symbol !== symbol ? `[${log.symbol}] ` : ''}
                  {log.text}
                </span>
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
          매수는 AI 판단 전용. 익절=목표 도달, 손절=손절률 도달, 트레일링=고점 대비 하락 시 전량 매도.
          일일 손실 한도 도달 시 강제 OFF. 쿨다운(30s)·탭 숨김 일시정지로 보호. 현재 종목만.
          설정·로그는 저장되어 새로고침 후에도 유지. 모바일은 앱을 포그라운드로 유지(화면 꺼짐 방지 권장).
        </div>
      )}
    </div>
  );
}

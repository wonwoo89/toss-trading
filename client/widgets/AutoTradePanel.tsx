import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { NumberField } from './NumberField';
import { Button } from '../shared/ui/Button';
import { SegmentedControl } from '../shared/ui/SegmentedControl';
import { Switch } from '../shared/ui/Switch';
import { Typography } from '../shared/ui/Typography';
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
import { api, type AiDecision, type LiveTraderStatus } from '../shared/api/client';
import type { ChartCandle, CommissionRaw, HoldingItem, Order, UsMarketCalendarRaw } from '../shared/types';
import { resolveUsMarketSession } from '../shared/lib/usMarketCalendar';
import { resolveUsCommissionRatePercent } from '../shared/lib/commissionBreakEven';
import { subscribeAutoTradeApply } from '../shared/lib/autoTradeApplyBus';

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
  /** 실제 주문 실행. OrderForm 의 검증된 제출 경로 재사용.
   *  orderAmount 가 있으면 금액(달러) 시장가 소수점 매수(정규장 한정). */
  onAutoExecute: (
    side: 'BUY' | 'SELL',
    quantity: number,
    limitPrice?: number,
    orderAmount?: number
  ) => void;
  /** 미체결 주문 취소 — 가격 이탈로 잡히지 않는 자동 지정가 주문을 정리하고 재판단하기 위함. */
  /** AI 매매(실주문 모드) 활성 여부 변경 알림 — OrderForm 안내 문구에 사용. */
  onExecModeChange?: (active: boolean) => void;
  /** 모바일(좁은 폭) 여부 — 화면 꺼짐/백그라운드 시 멈춤 안내를 노출하기 위함. */
  isMobile?: boolean;
  /** '로그 보기' 대체 동작(모바일 탭 전환용) — 없으면 /server-ai 로 이동. */
  onViewLogs?: () => void;
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
  /** 미국장 캘린더 — 정규장(소수점 매도 가능) 판별에 사용. */
  usMarketCalendar?: UsMarketCalendarRaw | null;
  /** 계좌 수수료율 — 익절 목표가에 실제 수수료(왕복)를 반영하기 위함. */
  commissions?: CommissionRaw[];
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
  /** 금액(달러) 시장가 매수 — 배정 금액이 1주 미만일 때 소수점 매수용(정규장 한정). */
  orderAmount?: number;
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
/** 추세 홀드 중 고점 대비 허용 하락(%) — 트레일링 설정이 0(끔)일 때의 기본값. */
const TP_HOLD_TRAIL_PCT = 0.5;
/** 미체결 자동 취소: 이 시간 이상 미체결이고(90s)… */
/** …가격이 지정가에서 불리한 방향으로 이 % 이상 이탈했으면 취소 후 재판단. */
/** 체결 우선 지정가: 상대 호가를 넘어 즉시 체결을 노리는 버퍼(%). */
const CROSS_BUFFER_PCT = 0.1;
/** 체결 우선 지정가의 추격 상한(%) — 판단가에서 이 이상 벗어난 가격으로는 걸지 않는다. */
const MAX_CHASE_PCT = 0.5;
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
 *  - AI 매매(auto): AI 판단 + 가드 통과 시 확인 없이 자동 실주문(켤 때 확인, 탭 숨김 시 일시정지)
 *
 * 매수 진입은 AI 판단(useAi)으로만 이루어지고, 익절/손절/트레일링 보호 매도는 항상 동작한다.
 * 설정(모드·비율·한도)과 로그는 localStorage 에 영속돼 새로고침 후에도 유지된다.
 *
 * 안전장치: 킬 스위치(모드 OFF) · 손절률 · 트레일링 스탑 · 일일 손실 한도(도달 시 강제 OFF) ·
 * 쿨다운 · 탭 가시성(오토) · 감사로그. 데스크탑·모바일 모두 동작하되,
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
  onViewLogs,
  candles = [],
  candleInterval = '1m',
  bids = [],
  asks = [],
  previousClose,
  maxBuyQuantity,
  openOrders = [],
  currency = 'USD',
  usMarketCalendar,
  commissions = [],
}: AutoTradePanelProps) {
  // 설정은 localStorage 에서 복원(모바일 PWA 재시작 후에도 유지). 변경 시 즉시 저장.
  const [initialSettings] = useState(getAutoTradeSettings);
  // AI 매매는 켜뒀던 종목에서만 복원 — 다른 종목으로 이동(패널 리마운트)하면 안전을 위해 OFF.
  const restoredModeBlockedBySymbolChange =
    initialSettings.mode === 'auto' &&
    initialSettings.activeSymbol !== undefined &&
    initialSettings.activeSymbol !== symbol;
  // 'AI 매매'는 서버 실행으로 이관 — 로컬 저장 모드가 auto 여도 서버 상태 동기화(아래 effect)로만 복원.
  const [mode, setMode] = useState<AutoTradeMode>(
    restoredModeBlockedBySymbolChange || initialSettings.mode === 'auto' ? 'off' : initialSettings.mode
  );
  // 목표는 자동매매 자체 설정(저장/기본값)을 우선 — 주문폼의 전역 목표수익률(3% 등)이
  // AI 매매폼 기본값(1%)을 덮어쓰지 않게 한다. 자체 값이 없을 때만 전역값으로 폴백.
  const [targetPercent, setTargetPercent] = useState(() =>
    initialSettings.targetPercent > 0
      ? initialSettings.targetPercent
      : takeProfitRatePercent && takeProfitRatePercent > 0
        ? takeProfitRatePercent
        : 1
  );
  const [stopLossPercent, setStopLossPercent] = useState(initialSettings.stopLossPercent);
  const [trailingStopPercent, setTrailingStopPercent] = useState(
    initialSettings.trailingStopPercent
  );
  // 1회 매수 상한 — 서버 안전 상한(5%) 고정. 실거래 보호를 위해 인풋을 제거하고 상수로 둔다.
  const buyMaxPercent = 5;
  const [dailyLossLimitUsd, setDailyLossLimitUsd] = useState(initialSettings.dailyLossLimitUsd);
  // 추세 홀드 — 목표 도달 시 상승 추세면 익절을 보류하고 고점 추적(보전선 이탈 시 매도).
  const [holdTpOnTrend, setHoldTpOnTrend] = useState(initialSettings.holdTpOnTrend);
  const [useAtrLevels, setUseAtrLevels] = useState(initialSettings.useAtrLevels);
  // 매수는 항상 AI 판단으로만 이루어진다(오토=AI 매매 모드). 별도 토글 없음.
  const useAi = true;
  const [dailyRealizedUsd, setDailyRealizedUsd] = useState(getDailyRealizedUsd);

  // 정규장 여부 — 정규장에서만 미국주식 소수점(전량) 매도가 가능하다. 30초 주기로 갱신.
  const [sessionNow, setSessionNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setSessionNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const isRegularSession = resolveUsMarketSession(usMarketCalendar, sessionNow).kind === 'regular';

  const [logs, setLogs] = useState<LogEntry[]>(loadAutoTradeLogs);

  // AI(LLM) 판단: 봉 마감·의미있는 변동 시 서버에 스냅샷을 보내 BUY/SELL/HOLD 를 받아 실행한다.
  // 안전: 손절/쿨다운/탭가시성/킬스위치 등 가드는 그대로 적용되고, AI 는 그 안에서 '방향'만 정한다.
  const [aiDecision, setAiDecision] = useState<AiDecision | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  // 판단 이력은 ref 로만 유지 — 화면 표시는 AI 매매 페이지가 담당(다음 판단 컨텍스트용).
  const aiHistoryRef = useRef<AiHistoryEntry[]>([]);
  const aiInFlightRef = useRef(false);
  const aiLastCallRef = useRef(0);
  const aiLastClosedKeyRef = useRef<number | null>(null);
  const aiLastPriceRef = useRef<number | null>(null);

  const lastExecRef = useRef(0);
  // 종류별 마지막 기록 스냅샷(가격·수량·시각). 의미 있는 변동 판정 + 도배 억제에 사용.
  // 조건이 false(신호 사라짐)면 null 로 리셋해, 다시 켜질 때 새 에피소드로 즉시 기록.
  const lastSignalRef = useRef<
    Record<AutoActionKind, { price: number; qty: number; time: number } | null>
  >({ BUY: null, TP: null, SL: null, TS: null });
  // 트레일링 스탑 고점 추적 — 포지션 관찰 시작 이후의 최고가(초기값은 max(평단, 현재가)).
  const trailPeakRef = useRef<number | null>(null);
  // 추세 홀드 상태 — 목표 도달 후 매도를 보류 중이면 고점을 담는다(null=홀드 아님).
  const tpHoldRef = useRef<{ peak: number } | null>(null);
  // AI 매매(오토) 활성 시각 — 그 이후 접수된 주문만 미체결 자동 취소 대상(수동 주문 보호).
  // 이미 취소 요청한 주문 id — 폴링 반영 지연 동안 중복 취소 방지.
  // 손절 생략(보유 ≤1주) 로그를 에피소드당 1회로 제한하는 플래그.
  const slSkipLoggedRef = useRef(false);
  const tpSkipLoggedRef = useRef(false);
  // AI 재량 매도(SELL 의견)가 매도 불가 상태에서 반복될 때 로그 도배 방지(에피소드당 1회).
  const aiSellSkipLoggedRef = useRef(false);
  const tsSkipLoggedRef = useRef(false);

  // 설정 영속화 — 어떤 값이든 바뀌면 저장.
  useEffect(() => {
    saveAutoTradeSettings({
      mode,
      // AI 매매일 때만 현재 종목을 기록 — 종목 변경 시 자동 OFF 판정 기준.
      activeSymbol: mode === 'auto' ? symbol : undefined,
      useAi,
      targetPercent,
      stopLossPercent,
      trailingStopPercent,
      buyMaxPercent,
      dailyLossLimitUsd,
      holdTpOnTrend,
      useAtrLevels,
    });
  }, [mode, useAi, targetPercent, stopLossPercent, trailingStopPercent, buyMaxPercent, dailyLossLimitUsd, holdTpOnTrend, useAtrLevels, symbol]);

  // 로그 영속화 — 새로고침 후에도 감사 기록 유지.
  useEffect(() => {
    saveAutoTradeLogs(logs);
  }, [logs]);

  // 백테스트(최적화)에서 '적용'한 목표/손절을 즉시 반영 — 저장은 버스가 이미 처리.
  useEffect(() => {
    return subscribeAutoTradeApply((payload) => {
      setTargetPercent(payload.targetPercent);
      setStopLossPercent(payload.stopLossPercent);
      pushLog(
        'skip',
        'BUY',
        `${payload.source ?? '백테스트'} 설정 적용: 목표 +${payload.targetPercent}% / 손절 -${payload.stopLossPercent}%`
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // fixed 좌표라 스크롤하면 트리거와 분리된 채 화면에 남는다 — 스크롤/리사이즈 시 닫는다.
  useEffect(() => {
    if (!tipPos) return;
    const close = () => setTipPos(null);
    window.addEventListener('scroll', close, { capture: true, passive: true });
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [tipPos]);

  // AI 매매 모드 켜기는 실수 방지를 위해 명시적 확인을 받는다.
  const selectMode = (next: AutoTradeMode) => {
    if (next === mode) return;
    if (next === 'auto') {
      const ok =
        typeof window !== 'undefined' &&
        window.confirm(
          '서버 AI 매매를 켭니다.\n서버가 이 종목을 5분봉마다(±0.3% 급변 시 즉시) 판단해 확인 없이 실제 매수/매도 주문을 냅니다.\n브라우저/기기를 꺼도 계속 실행되며, 어느 기기에서든 같은 상태를 봅니다.\n끄려면 OFF 를 누르면 됩니다. 계속할까요?'
        );
      if (!ok) return;
      setServerBusySymbol(null);
      void api
        .saveLiveTraderConfig(buildLiveConfigRef.current(true))
        .catch((e: unknown) =>
          pushLog('block', 'BUY', `서버 AI 매매 시작 실패: ${e instanceof Error ? e.message : '오류'}`)
        );
    } else if (mode === 'auto') {
      // AI 매매 → 다른 모드/OFF: 서버 트레이더 정지.
      void api
        .saveLiveTraderConfig(buildLiveConfigRef.current(false))
        .catch((e: unknown) =>
          pushLog('block', 'SELL', `서버 AI 매매 정지 실패: ${e instanceof Error ? e.message : '오류'}`)
        );
      setLiveStatus(null);
    }
    // OFF → 재시작: 이전 세션의 로그·신호 스냅샷·AI 판단 이력을 모두 비우고 새로 시작.
    if (mode === 'off' && next !== 'off') {
      setLogs([]);
      lastSignalRef.current = { BUY: null, TP: null, SL: null, TS: null };
      aiHistoryRef.current = [];
      setAiDecision(null);
    }
    setMode(next);
  };

  useEffect(() => {
    lastSignalRef.current = { BUY: null, TP: null, SL: null, TS: null };
    trailPeakRef.current = null;
    setAiDecision(null);
    aiHistoryRef.current = [];
    aiLastClosedKeyRef.current = null;
    aiLastPriceRef.current = null;
  }, [symbol]);

  // AI 매매(실주문 모드) 활성 여부를 부모에 알린다(주문폼 안내용). 언마운트 시 해제.
  useEffect(() => {
    onExecModeChange?.(mode === 'auto');
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

  // 저장된 모드가 실주문 모드(AI 매매)로 복원됐음을 로그로 남긴다(1회).
  const restoredNoticeRef = useRef(false);
  useEffect(() => {
    if (restoredNoticeRef.current) return;
    restoredNoticeRef.current = true;
    if (restoredModeBlockedBySymbolChange) {
      pushLog(
        'block',
        'BUY',
        `종목 변경으로 자동매매 OFF (이전: ${initialSettings.activeSymbol} AI 매매)`
      );
    } else if (initialSettings.mode === 'auto') {
      pushLog(
        'trigger',
        'BUY',
        '설정 복원: AI 매매 모드로 재시작됨 (끄려면 OFF)'
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 서버 AI 매매 동기화(마운트 1회): 서버가 이 종목으로 실행 중이면 이어보기(설정도 서버값으로),
  // 다른 종목으로 실행 중이면 배너로 알린다.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const st = (await api.getLiveTraderStatus()).result;
        if (cancelled || !st.config.enabled) return;
        if (st.config.symbol === symbol.toUpperCase()) {
          syncingFromServerRef.current = true;
          setTargetPercent(st.config.targetPercent);
          setStopLossPercent(st.config.stopLossPercent);
          setTrailingStopPercent(st.config.trailingStopPercent);
          setDailyLossLimitUsd(st.config.dailyLossLimitUsd);
          setHoldTpOnTrend(st.config.holdTpOnTrend);
          setUseAtrLevels(st.config.useAtrLevels);
          setLiveStatus(st);
          setMode('auto');
          pushLog('trigger', 'BUY', '서버 AI 매매 실행 중 — 이 기기에서 이어봅니다');
        } else {
          setServerBusySymbol(st.config.symbol);
        }
      } catch {
        // 서버 미접속 등 — 무시(로컬 모드로 동작)
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // AI 매매(서버) 상태 폴링 — 5초. 서버에서 강제 OFF(한도 등)되면 로컬 모드도 내린다.
  useEffect(() => {
    if (mode !== 'auto') return;
    let cancelled = false;
    const load = async () => {
      try {
        const st = (await api.getLiveTraderStatus()).result;
        if (cancelled) return;
        setLiveStatus(st);
        if (!st.config.enabled || st.config.symbol !== symbol.toUpperCase()) {
          setMode('off');
          pushLog('block', 'SELL', '서버 AI 매매가 정지되었습니다(한도 도달 또는 다른 기기에서 변경)');
        }
      } catch {
        // 일시적 실패는 다음 폴링에서 회복
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, symbol]);

  // AI 매매 중 설정 변경 → 서버로 디바운스 푸시(서버→로컬 동기화 직후 1회는 에코 방지).
  useEffect(() => {
    if (mode !== 'auto') return;
    if (syncingFromServerRef.current) {
      syncingFromServerRef.current = false;
      return;
    }
    const timer = setTimeout(() => {
      void api.saveLiveTraderConfig(buildLiveConfigRef.current(true)).catch(() => undefined);
    }, 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, targetPercent, stopLossPercent, trailingStopPercent, buyMaxPercent, dailyLossLimitUsd, holdTpOnTrend, useAtrLevels]);

  // 파생 트리거 값 ──────────────────────────────────────────────
  /*
   * ── 소수점/수량 거래 기준(토스 제약 기반, 전 경로 공통) ──────────────
   * 매도:
   *  - 정규장: 소수점 전량 매도 가능(소수 8자리 내림). 소수점 수량은 '시장가'로만
   *    허용되므로 제출 시 시장가로 전환(StockPage.executeAutoOrder).
   *  - 비정규장(데이/프리/애프터): 정수 주만(내림). 보유가 1주 미만(소수점 잔량)이면
   *    매도 불가 → 익절/손절/트레일링/AI 매도 전부 생략(에피소드당 1회 로그).
   *    보유가 1주 이상이면 정수부만 매도(소수점 잔량은 정규장에서).
   * 매수:
   *  - 배정 예산 ≥ 1주: 정수 수량 지정가(체결 우선 가격) — 전 세션 공통.
   *  - 배정 예산 < 1주: 정규장 = 금액(orderAmount) 시장가 소수점 매수 /
   *    비정규장 = 1주로 올림(1회 매수 상한 이내일 때만, 초과 시 보류).
   */
  // 매도 수량 — 정규장은 소수점 전량(보유 잔량 그대로), 그 외 세션은 정수 주만(내림).
  // 부동소수 오차로 잔량을 초과하지 않도록 정규장 수량은 소수 8자리로 내림.
  const sellQty = (() => {
    if (sellableQuantity === undefined || sellableQuantity <= 0) return undefined;
    const q = isRegularSession
      ? Math.floor(sellableQuantity * 1e8) / 1e8
      : Math.floor(sellableQuantity);
    return q > 0 ? q : undefined;
  })();
  const hasPosition =
    holding !== undefined &&
    holding.quantity > 0 &&
    holding.averagePrice !== undefined &&
    holding.averagePrice > 0 &&
    sellQty !== undefined;

  // 체결 우선 지정가 — 판단 시점 현재가에 걸면 상승세에 밀려 미체결되기 쉽다.
  // 매수는 매도1호가(+버퍼)를 넘겨 즉시 체결을 노리되 판단가 +0.5% 를 상한으로,
  // 매도는 매수1호가(−버퍼)로 즉시 체결하되 판단가 −0.5% 를 하한으로 캡한다.
  const marketableBuyPrice = (price: number) => {
    const ask = asks[0]?.price;
    const base = ask !== undefined && ask > 0 ? Math.max(ask, price) : price;
    return Math.min(base * (1 + CROSS_BUFFER_PCT / 100), price * (1 + MAX_CHASE_PCT / 100));
  };
  const marketableSellPrice = (price: number) => {
    const bid = bids[0]?.price;
    const base = bid !== undefined && bid > 0 ? Math.min(bid, price) : price;
    return Math.max(base * (1 - CROSS_BUFFER_PCT / 100), price * (1 - MAX_CHASE_PCT / 100));
  };

  const tpPrice =
    hasPosition && holding!.averagePrice
      ? calculateTakeProfitSellPrice(
          holding!.averagePrice,
          sellQty!,
          targetPercent,
          getTakeProfitCostContext(holding),
          resolveUsCommissionRatePercent(commissions)
        )
      : undefined;
  const tpReached = tpPrice !== undefined && currentPrice !== undefined && currentPrice >= tpPrice;

  const slPrice =
    hasPosition && holding!.averagePrice
      ? holding!.averagePrice * (1 - stopLossPercent / 100)
      : undefined;
  const slReached = slPrice !== undefined && currentPrice !== undefined && currentPrice <= slPrice;

  const active = mode !== 'off';
  // 로컬 트리거(익절/손절/트레일링/AI 호출)는 드라이런에서만 돈다 — AI 매매는 서버 실행.
  const localActive = mode === 'dryrun';
  const dailyLossReached = dailyLossLimitUsd > 0 && dailyRealizedUsd <= -dailyLossLimitUsd;

  // 서버(포어그라운드) AI 매매 상태 — 기기 간 공유. mode==='auto' 인 동안 5초 폴링.
  const [liveStatus, setLiveStatus] = useState<LiveTraderStatus | null>(null);
  const [serverBusySymbol, setServerBusySymbol] = useState<string | null>(null);
  const syncingFromServerRef = useRef(false);
  const buildLiveConfig = (enabled: boolean) => ({
    enabled,
    symbol,
    targetPercent,
    stopLossPercent,
    trailingStopPercent,
    buyMaxPercent,
    dailyLossLimitUsd,
    holdTpOnTrend,
    useAtrLevels,
  });
  const buildLiveConfigRef = useRef(buildLiveConfig);
  buildLiveConfigRef.current = buildLiveConfig;

  // 실제 주문 실행 + 공통 가드(제출 중·쿨다운·일일 손실 한도). 통과해 주문을 내면 true.
  const runExecute = (action: PendingAction): boolean => {
    if (submitting) return false;
    // 일일 손실 한도 도달 시 신규 매수 차단(보호 매도는 허용).
    if (action.side === 'BUY' && dailyLossLimitUsd > 0 && getDailyRealizedUsd() <= -dailyLossLimitUsd) {
      pushLog('block', 'BUY', `차단(일일 손실 한도 도달): ${action.label}`);
      return false;
    }
    // 쿨다운은 무인 자동(오토) 연사 방지용.
    if (mode === 'auto' && Date.now() - lastExecRef.current < COOLDOWN_MS) {
      const wait = Math.ceil((COOLDOWN_MS - (Date.now() - lastExecRef.current)) / 1000);
      pushLog('block', action.side, `차단(쿨다운 ${wait}s 남음): ${action.label}`);
      return false;
    }
    onAutoExecute(action.side, action.quantity, action.limitPrice, action.orderAmount);
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

  // 트리거 처리: 드라이런=기록만, 오토=가드 통과 시 즉시 실행.
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
    }
  };

  // 익절 매도 트리거 — '추세 홀드'가 켜져 있으면 목표 도달 시 상승 추세에서는 매도를 보류하고
  // 고점을 추적한다. 이후 보전선(익절 목표가) 또는 고점 대비 트레일 % 이탈 시 전량 매도해,
  // 최악의 경우에도 목표 수익은 확보하면서 추세 연장 이익을 노린다.
  useEffect(() => {
    if (!localActive) return;
    if (!hasPosition) tpHoldRef.current = null; // 포지션 종료 → 홀드 해제

    // 정규장 밖에서는 소수점 매도가 불가해 보유 1주 미만(소수점 잔량)이면 익절을 생략(전 로컬 모드 공통).
    const blockedByFractional = !isRegularSession && (holding?.quantity ?? 0) < 1;

    // 1) 홀드 중: 고점 갱신 + 이탈 판정. 보전선 아래로 내려오면 tpReached 가 false 여도 매도.
    const hold = tpHoldRef.current;
    if (hold && sellQty !== undefined && currentPrice !== undefined && tpPrice !== undefined) {
      if (currentPrice > hold.peak) hold.peak = currentPrice;
      const trailPct = trailingStopPercent > 0 ? trailingStopPercent : TP_HOLD_TRAIL_PCT;
      const floorHit = currentPrice <= tpPrice;
      const trailHit = currentPrice <= hold.peak * (1 - trailPct / 100);
      if (floorHit || trailHit) {
        if (blockedByFractional) {
          if (!tpSkipLoggedRef.current) {
            tpSkipLoggedRef.current = true;
            pushLog('block', 'SELL', `익절 매도 생략(보유 ${holding?.quantity ?? 0}주 < 1주 — 소수점 잔량): ${symbol}`);
          }
          return;
        }
        if (shouldFire('TP', currentPrice, sellQty)) {
          const why = floorHit
            ? `보전선 $${fmtPrice(tpPrice)} 이탈`
            : `고점 $${fmtPrice(hold.peak)} 대비 -${trailPct}%`;
          const label = `익절 매도(전량·추세홀드 종료) ${symbol} ${sellQty}주 @ $${fmtPrice(currentPrice)} (${why})`;
          fireTrigger(
            { id: crypto.randomUUID(), kind: 'TP', side: 'SELL', quantity: sellQty, limitPrice: marketableSellPrice(currentPrice), label },
            `모의 ${label}`,
            currentPrice,
            sellQty
          );
        }
      }
      return; // 홀드 유지 중엔 신규 익절 판정을 하지 않는다
    }

    // 2) 목표 도달 판정
    if (tpReached && sellQty !== undefined && currentPrice !== undefined) {
      if (blockedByFractional) {
        if (!tpSkipLoggedRef.current) {
          tpSkipLoggedRef.current = true;
          pushLog('block', 'SELL', `익절 매도 생략(보유 ${holding?.quantity ?? 0}주 < 1주 — 소수점 잔량): ${symbol}`);
        }
        return;
      }
      // 추세 홀드: 완성봉 기준 상승 추세가 확정이면 매도를 보류하고 고점 추적 시작.
      if (holdTpOnTrend) {
        const trend = computeCandleTrend(candles);
        if (trend.confirmedUp) {
          tpHoldRef.current = { peak: currentPrice };
          pushLog(
            'skip',
            'SELL',
            `익절 보류(상승 추세 ${trend.confirmedBars}봉 확정) — 고점 추적 시작, 보전선 $${fmtPrice(tpPrice ?? currentPrice)}`
          );
          return;
        }
      }
      if (shouldFire('TP', currentPrice, sellQty)) {
        const label = `익절 매도(전량) ${symbol} ${sellQty}주 @ $${fmtPrice(currentPrice)} (목표 +${targetPercent}%)`;
        fireTrigger(
          { id: crypto.randomUUID(), kind: 'TP', side: 'SELL', quantity: sellQty, limitPrice: marketableSellPrice(currentPrice), label },
          `모의 ${label}`,
          currentPrice,
          sellQty
        );
      }
    } else {
      lastSignalRef.current.TP = null;
      tpSkipLoggedRef.current = false; // 익절 조건 해소 → 다음 에피소드에서 다시 1회 안내
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, mode, isTabVisible, tpReached, sellQty, currentPrice, symbol, targetPercent, holdTpOnTrend, trailingStopPercent, candles, hasPosition]);

  // 손절 매도 트리거
  useEffect(() => {
    if (!localActive) return;
    if (slReached && sellQty !== undefined && currentPrice !== undefined) {
      // 정규장 밖에서는 소수점 매도가 불가해 보유 1주 미만(소수점 잔량)이면 손절을 생략.
      // 정규장은 소수점 전량 매도가 가능하므로 생략하지 않는다.
      if (!isRegularSession && (holding?.quantity ?? 0) < 1) {
        // 생략 로그는 이 손절 에피소드당 1회만(조건이 계속 참이라 매 폴링마다 도배되는 것 방지).
        if (!slSkipLoggedRef.current) {
          slSkipLoggedRef.current = true;
          pushLog('block', 'SELL', `손절 매도 생략(보유 ${holding?.quantity ?? 0}주 < 1주 — 소수점 잔량): ${symbol}`);
        }
        return;
      }
      if (shouldFire('SL', currentPrice, sellQty)) {
        const label = `손절 매도(전량) ${symbol} ${sellQty}주 @ $${fmtPrice(currentPrice)} (손절 -${stopLossPercent}%)`;
        fireTrigger(
          { id: crypto.randomUUID(), kind: 'SL', side: 'SELL', quantity: sellQty, limitPrice: marketableSellPrice(currentPrice), label },
          `모의 ${label}`,
          currentPrice,
          sellQty
        );
      }
    } else {
      lastSignalRef.current.SL = null;
      slSkipLoggedRef.current = false; // 손절 조건 해소 → 다음 에피소드에서 다시 1회 안내
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

    if (!localActive) return;
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
      // 추세 홀드 중에도 익절 트리거(보전선/홀드 트레일)가 출구를 담당한다.
      !tpReached &&
      !slReached &&
      tpHoldRef.current === null;

    if (tsReached && currentPrice !== undefined && trailPeak !== null) {
      // 비정규장 소수점 잔량(매도 불가) — 익절/손절과 동일하게 에피소드당 1회만 안내.
      if (sellQty === undefined) {
        if (!isRegularSession && (holding?.quantity ?? 0) < 1 && !tsSkipLoggedRef.current) {
          tsSkipLoggedRef.current = true;
          pushLog('block', 'SELL', `트레일링 매도 생략(보유 ${holding?.quantity ?? 0}주 < 1주 — 소수점 잔량): ${symbol}`);
        }
        return;
      }
      if (shouldFire('TS', currentPrice, sellQty)) {
        const label = `트레일링 매도(전량) ${symbol} ${sellQty}주 @ $${fmtPrice(currentPrice)} (고점 $${fmtPrice(trailPeak)} 대비 -${trailingStopPercent}%)`;
        fireTrigger(
          { id: crypto.randomUUID(), kind: 'TS', side: 'SELL', quantity: sellQty, limitPrice: marketableSellPrice(currentPrice), label },
          `모의 ${label}`,
          currentPrice,
          sellQty
        );
      }
    } else {
      lastSignalRef.current.TS = null;
      tsSkipLoggedRef.current = false;
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
    aiHistoryRef.current = [entry, ...aiHistoryRef.current].slice(0, MAX_AI_HISTORY);
    return entry.id;
  };

  const markAiHistoryExecuted = (id: string) => {
    aiHistoryRef.current = aiHistoryRef.current.map((h) =>
      h.id === id ? { ...h, executed: true } : h
    );
  };

  // AI 결정 실행: BUY/SELL 을 기존 모드 정책(드라이런=기록, 오토=즉시)·가드로 라우팅.
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
      const budgetUsd = Math.floor(buyingPower * (effectivePct / 100) * 100) / 100;
      let qty = Math.floor(budgetUsd / price);
      if (maxBuyQuantity !== undefined) qty = Math.min(qty, maxBuyQuantity);
      if (qty <= 0) {
        // 배정 금액(주문가능 × 제안 비중)이 1주 가격 미만 — 주문가능 부족이 아니라 소량 제안.
        // 정규장이면 금액(orderAmount) 시장가로 소수점 매수를 실행한다(토스 지원 경로).
        if (isRegularSession && budgetUsd >= 1) {
          action = {
            id: crypto.randomUUID(),
            kind: 'BUY',
            side: 'BUY',
            quantity: 0,
            orderAmount: budgetUsd,
            label: `AI 소수점 매수 ${symbol} $${budgetUsd}(비중 ${effectivePct}%) 시장가 — ${decision.reason}`,
            aiHistoryId: historyId,
          };
        } else if (price <= buyingPower * (buyMaxPercent / 100)) {
          // 정규장 외: 금액(소수점) 주문 불가 → 1주 정수 수량으로 올림해 매수.
          // 단 1주 가격이 '1회 매수' 상한(주문가능 × buyMaxPercent%) 이내일 때만 — 상한은 지킨다.
          action = {
            id: crypto.randomUUID(),
            kind: 'BUY',
            side: 'BUY',
            quantity: 1,
            limitPrice: marketableBuyPrice(price),
            label: `AI 매수 ${symbol} 1주(비중 ${effectivePct}%→최소 수량 조정) @ $${fmtPrice(marketableBuyPrice(price))} — ${decision.reason}`,
            aiHistoryId: historyId,
          };
        } else {
          pushLog(
            'block',
            'BUY',
            `AI 매수 신호(비중 ${effectivePct}%) 보류 — 1주($${fmtPrice(price)})가 1회 매수 상한($${fmtPrice(buyingPower * (buyMaxPercent / 100))}) 초과: ${decision.reason}`
          );
          return;
        }
      } else {
        action = {
          id: crypto.randomUUID(),
          kind: 'BUY',
          side: 'BUY',
          quantity: qty,
          limitPrice: marketableBuyPrice(price),
          label: `AI 매수 ${symbol} ${qty}주(비중 ${effectivePct}%) @ $${fmtPrice(marketableBuyPrice(price))} — ${decision.reason}`,
          aiHistoryId: historyId,
        };
      }
    } else {
      // SELL: 보유분 전량 청산 제안. (TP/SL 보호와 별개의 재량 매도)
      if (sellQty === undefined || sellQty <= 0 || currentPrice === undefined) {
        // 비정규장 소수점 잔량(매도 불가) 상태에서 AI 가 손절/매도 의견을 반복해도
        // 생략 로그는 에피소드당 1회만 — 매도 가능해지면(정규장 진입 등) 플래그 리셋.
        if (!aiSellSkipLoggedRef.current) {
          aiSellSkipLoggedRef.current = true;
          const dustQty = holding?.quantity ?? 0;
          pushLog(
            'block',
            'SELL',
            dustQty > 0
              ? `AI 매도 생략(비정규장 소수점 잔량 ${dustQty}주 — 정규장에서 처리 가능): ${decision.reason}`
              : `AI 매도 보류 — 보유 없음: ${decision.reason}`
          );
        }
        return;
      }
      aiSellSkipLoggedRef.current = false;
      action = {
        id: crypto.randomUUID(),
        kind: 'TP',
        side: 'SELL',
        quantity: sellQty,
        limitPrice: marketableSellPrice(currentPrice),
        label: `AI 매도(전량) ${symbol} ${sellQty}주 @ $${fmtPrice(marketableSellPrice(currentPrice))} — ${decision.reason}`,
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
    }
  };

  // AI 트리거: 봉 마감(완성봉 변경) 또는 의미있는 가격 변동 시(최소 간격 내 억제) 서버에 판단 요청.
  useEffect(() => {
    if (!useAi || !localActive) return;
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
        // 매도 불가 상태(비정규장 소수점 잔량)는 0 으로 명시 — AI 가 매도 불가를 알고 SELL 을 삼가게.
        sellableQuantity: sellQty ?? ((holding?.quantity ?? 0) > 0 ? 0 : undefined),
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

  const navigate = useNavigate();

  return (
    <div className={`auto-trade ${active ? 'is-active' : ''}`}>
      <div className="auto-trade__head">
        <Typography size={12} className="auto-trade__title">
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
        </Typography>
        <SegmentedControl
          className="auto-trade__modes"
          aria-label="자동매매 모드"
          value={mode}
          onChange={selectMode}
          options={[
            { value: 'off', label: 'OFF' },
            { value: 'dryrun', label: '드라이런' },
            { value: 'auto', label: 'AI 매매', activeClassName: 'is-danger' },
          ]}
        />
      </div>

      <div className="auto-trade__controls">
        <NumberField
          className="auto-trade__field"
          label="목표 수익률"
          unit="%"
          min={0.1}
          value={targetPercent}
          onChange={setTargetPercent}
        />
        <NumberField
          className="auto-trade__field"
          label="손절률"
          unit="%"
          min={0.1}
          value={stopLossPercent}
          onChange={setStopLossPercent}
        />
        <NumberField
          className="auto-trade__field"
          label="트레일링"
          unit="%"
          title="포지션 고점 대비 이 % 하락 시 전량 매도(이익 보존). 0 = 끔."
          min={0}
          value={trailingStopPercent}
          onChange={setTrailingStopPercent}
        />
        <NumberField
          className="auto-trade__field auto-trade__field--daily"
          label="일손실"
          unit="$"
          title="자동매매 실현 손실이 오늘 이 금액을 넘으면 강제 OFF. 0 = 끔."
          min={0}
          value={dailyLossLimitUsd}
          onChange={setDailyLossLimitUsd}
        />
      </div>

      {/* 토글 옵션 그룹 — 숫자 설정과 분리해 한 곳에 모아 배치 */}
      <div className="auto-trade__options">
        <div
          className="auto-trade__option"
          title={`목표 도달 시 상승 추세면 매도를 보류하고 고점을 추적합니다. 보전선(목표가) 또는 고점 대비 -${trailingStopPercent > 0 ? trailingStopPercent : TP_HOLD_TRAIL_PCT}% 이탈 시 전량 매도해 목표 수익은 확보합니다.`}
        >
          <Typography size={12} className="auto-trade__option-label">추세 홀드</Typography>
          <Switch
            checked={holdTpOnTrend}
            onChange={setHoldTpOnTrend}
            aria-label="목표 도달 시 추세 홀드(익절 보류 후 고점 추적)"
          />
        </div>
        <div
          className="auto-trade__option"
          title="변동성(ATR) 기반 동적 목표/손절 — 서버 AI 매매 전용. 목표는 설정값 이상(2×ATR, 최대 3배), 손절은 설정값 이하(1.5×ATR)로 종목 변동성에 맞춰 자동 조정합니다."
        >
          <Typography size={12} className="auto-trade__option-label">ATR 자동</Typography>
          <Switch
            checked={useAtrLevels}
            onChange={setUseAtrLevels}
            aria-label="변동성(ATR) 기반 동적 목표/손절 (서버 AI 매매 전용)"
          />
        </div>
      </div>

      {dailyLossLimitUsd > 0 && (
        <Typography as="p" size={12} className={`auto-trade__daily-pnl ${dailyLossReached ? 'is-limit' : ''}`}>
          오늘 자동매매 실현 손익 $
          {(mode === 'auto' && liveStatus ? liveStatus.todayRealizedUsd : dailyRealizedUsd).toFixed(2)}
          {' '}/ 한도 -${dailyLossLimitUsd}
          {dailyLossReached ? ' — 한도 도달(신규 매수 차단)' : ''}
        </Typography>
      )}

      {serverBusySymbol && mode !== 'auto' && (
        <Typography as="p" size={12} className="auto-trade__server-busy">
          ⚠ 서버 AI 매매가 <strong>{serverBusySymbol}</strong> 에서 실행 중입니다. 이 종목에서 켜면
          기존 실행은 정지됩니다.
        </Typography>
      )}

      {mode === 'auto' && liveStatus && (
        <Typography as="p" size={12} className="auto-trade__server-status">
          🖥 서버 실행 중{liveStatus.session ? ` · 세션 ${liveStatus.session}` : ''} · 오늘 실현 $
          {liveStatus.todayRealizedUsd.toFixed(2)}
          {liveStatus.position
            ? ` · 보유 ${liveStatus.position.quantity}주 @ $${liveStatus.position.averagePrice.toFixed(2)}` +
              (liveStatus.position.profitLossPct !== undefined
                ? ` (${liveStatus.position.profitLossPct >= 0 ? '+' : ''}${liveStatus.position.profitLossPct.toFixed(2)}%)`
                : '')
            : ' · 보유 없음'}
          {liveStatus.lastError ? ` · 오류: ${liveStatus.lastError}` : ''}
        </Typography>
      )}

      <div className="auto-trade__ai">
          <Typography size={12} className="auto-trade__ai-head">
            🤖 AI {aiLoading ? '판단 중…' : aiDecision ? '' : '대기'}
          </Typography>
          {aiDecision && (
            <Typography
              size={12}
              className={`auto-trade__ai-decision is-${aiDecision.action.toLowerCase()}${aiDecision.fallback ? ' is-fallback' : ''}`}
            >
              {aiDecision.action === 'BUY' ? '매수' : aiDecision.action === 'SELL' ? '매도' : '관망'}
              {aiDecision.confidence ? ` ${(aiDecision.confidence * 100).toFixed(0)}%` : ''} — {aiDecision.reason}
            </Typography>
          )}
          {/* 판단 이력·상세 로그는 AI 매매 페이지에서 — 차트 영역은 최신 판단 한 줄만 유지 */}
      </div>

      {isMobile && active && (
        <Typography as="p" size={12} className="auto-trade__mobile-hint">
          📱 모바일에선 화면이 꺼지거나 앱을 벗어나면 자동 실행이 멈춰요. 상단 👁(화면 꺼짐 방지)를
          켜고 이 화면을 포그라운드로 유지하세요.
        </Typography>
      )}

      {mode === 'auto' && !isTabVisible && (
        <Typography as="p" size={12} className="auto-trade__paused">⏸ 탭이 가려져 자동 실행 일시정지 중 — 이 탭을 다시 보면 재개됩니다.</Typography>
      )}

      {/* 판단/트리거/실행 로그는 AI 매매 페이지에서 확인 — 차트 영역에선 이동 버튼만 제공 */}
      <div className="auto-trade__logs-link">
        <Button size="sm" variant="ghost" onClick={() =>
            isMobile && onViewLogs
              ? onViewLogs()
              : navigate('/server-ai', { state: { openLiveLog: true } })
          }>
          로그 보기 →
        </Button>
      </div>

      {tipPos &&
        createPortal(
        <div
          className="auto-trade__tip"
          role="tooltip"
          style={{ position: 'fixed', top: tipPos.top, left: tipPos.left, width: TIP_WIDTH }}
        >
          <Typography as="b" size={12}>드라이런</Typography> 모의 기록만(실주문 없음)
          <br />
          <Typography as="b" size={12}>AI 매매</Typography> 서버에서 실행 — 기기를 꺼도 지속, 모든 기기에서 상태 공유
          <br />
          매수는 AI 판단 전용. 익절=목표 도달, 손절=손절률 도달, 트레일링=고점 대비 하락 시 전량 매도.
          일일 손실 한도 도달 시 강제 OFF. 쿨다운(30s)·탭 숨김 일시정지로 보호. 현재 종목만.
          설정·로그는 저장되어 새로고침 후에도 유지. 모바일은 앱을 포그라운드로 유지(화면 꺼짐 방지 권장).
        </div>,
        document.body
      )}
    </div>
  );
}

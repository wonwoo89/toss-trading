import { useEffect, useMemo, useRef, useState } from 'react';
import { StockHoldingSummary } from './StockHoldingSummary';
import { AutoTradePanel } from './AutoTradePanel';
import { useToast } from '../app/providers/ToastContext';
import { buildBuyBreakEvenHint } from '../shared/lib/commissionBreakEven';
import {
  formatPrice,
  formatUsd,
  getKrProfitLossClass,
  usdMaxFractionDigits,
} from '../shared/lib/formatHoldings';
import { buildDayChangeMetric } from '../shared/lib/marketAnalytics';
import { TAKE_PROFIT_RATE_OPTIONS } from '../shared/lib/takeProfitRatePreference';
import { getStoredPriceMode, setStoredPriceMode } from '../shared/lib/priceModePreference';
import { subscribeLimitPriceSelect } from '../shared/lib/limitPriceBus';
import {
  getStoredQuantityPercent,
  setStoredQuantityPercent,
} from '../shared/lib/quantityPercentPreference';
import type { CandleInterval, ChartCandle, HoldingItem, Order } from '../shared/types';
import { formatOrderSuccessMessage } from '../shared/lib/formatOrderToast';
import type { CreateOrderPayload, OrderSubmitOptions, OrderSubmitResult } from '../shared/types';

type PriceMode = 'limit' | 'current' | 'market';

const QUANTITY_PERCENTAGES = [1, 10, 25, 50, 100] as const;

const PRICE_MODES = ['limit', 'current', 'market'] as const satisfies readonly PriceMode[];

interface OrderFormProps {
  symbol: string;
  currentPrice?: number;
  currency?: string;
  previousClose?: number;
  buyingPower?: number;
  sellableQuantity?: number;
  holdingQuantity?: number;
  holdingAveragePrice?: number;
  holdingMarketValue?: number;
  holdingProfitLoss?: number;
  holdingProfitLossRate?: number;
  takeProfitRatePercent?: number;
  onTakeProfitRateChange?: (rate: number) => void;
  commissionRatePercent?: number;
  candles?: ChartCandle[];
  candleInterval?: CandleInterval;
  bids?: { price: number; quantity: number }[];
  asks?: { price: number; quantity: number }[];
  holding?: HoldingItem;
  /** 이 종목의 미체결 주문 — 자동매매 AI 판단 컨텍스트로 전달. */
  openOrders?: Order[];
  onSubmit: (
    payload: CreateOrderPayload,
    options?: OrderSubmitOptions
  ) => Promise<OrderSubmitResult | void>;
}

function quantityFromPercent(available: number, percent: number) {
  if (percent >= 100) return Math.floor(available);
  return Math.floor(available * (percent / 100));
}

function getMaxBuyQuantity(buyingPower: number, unitPrice: number) {
  if (unitPrice <= 0) return 0;
  return Math.floor(buyingPower / unitPrice);
}

function formatOrderQuantity(value: number) {
  const rounded = Math.round(value * 10000) / 10000;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

// US 주식 최소 호가단위(Reg NMS Rule 612): $1 이상은 $0.01, $1 미만은 $0.0001(서브-페니).
function tickSizeFor(price: number) {
  return price < 1 ? 0.0001 : 0.01;
}

// USD 지정가를 해당 가격대의 호가단위로 내림한다($1 이상 센트, $1 미만 서브-페니).
function floorToTick(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return value;
  const inv = Math.round(1 / tickSizeFor(value)); // 0.01→100, 0.0001→10000 (부동소수 오차 방지)
  return Math.floor(value * inv) / inv;
}

// 가격 입력칸용 값. 콤마 없이 $1 미만은 4자리·그 외 2자리까지, 불필요한 0 제거.
function priceInputValue(value: number) {
  return String(Number(value.toFixed(usdMaxFractionDigits(value))));
}

// 숫자(소수) 입력 정제 — 숫자와 점 1개만 허용. 빈 값 허용(가격은 비우면 현재가 사용).
// type="number" 의 강제 변환/스피너 없이 자유 편집 + 소수 키보드(inputMode)를 쓰기 위함.
function sanitizeDecimalInput(raw: string) {
  let s = raw.replace(/[^0-9.]/g, '');
  const dot = s.indexOf('.');
  if (dot !== -1) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '');
  return s;
}

function getOrderFormFocusables(form: HTMLFormElement) {
  const selector = [
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
  ].join(', ');

  return Array.from(form.querySelectorAll<HTMLElement>(selector)).filter(
    (element) => element.getClientRects().length > 0
  );
}

function isEditableInputFocused() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  if (active.isContentEditable) return true;

  const tag = active.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function getQuantityPercentFromKey(event: KeyboardEvent) {
  const match = event.code.match(/^(?:Digit|Numpad)([1-5])$/);
  if (!match) return undefined;
  return QUANTITY_PERCENTAGES[Number(match[1]) - 1];
}

function getAvailablePriceModes(currentPrice?: number) {
  return PRICE_MODES.filter((mode) => mode !== 'current' || currentPrice !== undefined);
}

function getAdjacentPriceMode(current: PriceMode, direction: 1 | -1, currentPrice?: number) {
  const available = getAvailablePriceModes(currentPrice);
  if (available.length === 0) return current;

  const currentIndex = available.indexOf(current);
  const safeIndex = currentIndex === -1 ? 0 : currentIndex;
  return available[(safeIndex + direction + available.length) % available.length];
}

function focusNextOrderFormField(form: HTMLFormElement, reverse: boolean) {
  const focusables = getOrderFormFocusables(form);
  if (focusables.length === 0) return;

  const activeElement = document.activeElement;
  const currentIndex = focusables.findIndex((element) => element === activeElement);

  if (reverse) {
    const nextIndex = currentIndex <= 0 ? focusables.length - 1 : currentIndex - 1;
    focusables[nextIndex].focus();
    return;
  }

  const nextIndex =
    currentIndex === -1 || currentIndex >= focusables.length - 1 ? 0 : currentIndex + 1;
  focusables[nextIndex].focus();
}

export function OrderForm({
  symbol,
  currentPrice,
  currency = 'USD',
  previousClose,
  buyingPower,
  sellableQuantity,
  holdingQuantity,
  holdingAveragePrice,
  holdingMarketValue,
  holdingProfitLoss,
  holdingProfitLossRate,
  takeProfitRatePercent = 3,
  onTakeProfitRateChange,
  commissionRatePercent = 0.015,
  candles = [],
  candleInterval = '1m',
  bids = [],
  asks = [],
  holding,
  openOrders = [],
  onSubmit,
}: OrderFormProps) {
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const pendingSideRef = useRef<'BUY' | 'SELL' | null>(null);
  // 자동매매 실행 시에는 목표수익률 자동 매도를 건너뛴다(체크돼 있어도 미실행).
  const skipTakeProfitRef = useRef(false);
  // 제출 직전 결정된 주문 수량(사이드별 %기준). 설정돼 있으면 handleSubmit 이 이 값을 우선 사용.
  const pendingQuantityRef = useRef<number | null>(null);
  // 자동매매 실행 시 제출에 쓸 지정가를 동기 전달(상태 flush 레이스 방지). null 이면 일반 가격 로직 사용.
  const pendingLimitPriceRef = useRef<number | null>(null);
  const [priceMode, setPriceMode] = useState<PriceMode>(getStoredPriceMode);
  const [quantity, setQuantity] = useState('');
  // 마지막 선택한 수량 비율을 기억(영속) → 종목 전환·재접속 후에도 미리 선택돼 1탭 주문 가능.
  const [selectedQuantityPercent, setSelectedQuantityPercent] = useState<number | undefined>(
    getStoredQuantityPercent
  );
  const [price, setPrice] = useState('');
  const [orderAmount, setOrderAmount] = useState('');
  const [useAmountOrder, setUseAmountOrder] = useState(false);
  const [useTakeProfitSell, setUseTakeProfitSell] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // 세미오토/오토 실행 중에는 주문 입력 영역을 숨기고 자동 실행 내용만 노출(AutoTradePanel 이 알림).
  const [autoExecActive, setAutoExecActive] = useState(false);

  // 자동매매는 데스크탑·모바일 모두 제공. isDesktop 은 모바일 안내(화면 꺼짐 방지) 노출 판정에 사용.
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== 'undefined' && window.innerWidth > 1100
  );
  useEffect(() => {
    const update = () => setIsDesktop(window.innerWidth > 1100);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  const { showToast } = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const limitPriceManualRef = useRef(false);

  // 주문/자동매매는 현재 미국주식(USD)만 지원. 국내주식(KRW 등)은 조회 전용으로,
  // 시세·차트·보유는 보여주되 주문 실행 UI 전체를 숨기고 안내만 노출한다.
  const isOrderable = currency === 'USD';

  // Reset form state when symbol changes (for navigation without full reload)
  // This ensures inputs are fresh for the new symbol's data
  useEffect(() => {
    if (symbol) {
      setQuantity('');
      // 수량 비율은 리셋하지 않고 저장된 선택을 유지(빠른 주문). 직접 입력 수량만 비운다.
      setSelectedQuantityPercent(getStoredQuantityPercent());
      setPrice('');
      setOrderAmount('');
      limitPriceManualRef.current = false;
      // Keep current side or reset to 'BUY' if preferred; current keeps user choice
    }
  }, [symbol]);

  const updateTakeProfitRate = (rate: number) => {
    if (!Number.isFinite(rate) || rate <= 0) return;
    onTakeProfitRateChange?.(rate);
  };

  // 전일대비 당일 변동(주문폼 최상단 시세 블록). 색상은 KR 관례(상승 빨강/하락 파랑).
  const dayChange = useMemo(
    () => buildDayChangeMetric(previousClose, currentPrice, currency),
    [previousClose, currentPrice, currency]
  );
  const dayChangeDiff =
    previousClose !== undefined && previousClose > 0 && currentPrice !== undefined
      ? currentPrice - previousClose
      : undefined;

  const isPriceInputDisabled = priceMode === 'current' || priceMode === 'market';

  const effectiveOrderPrice = priceMode === 'limit' ? Number(price) || currentPrice : currentPrice;

  const effectiveBuyPrice = effectiveOrderPrice;

  const maxBuyQuantity = useMemo(() => {
    if (buyingPower === undefined || buyingPower <= 0) return undefined;
    if (effectiveBuyPrice === undefined || effectiveBuyPrice <= 0) return undefined;
    return getMaxBuyQuantity(buyingPower, effectiveBuyPrice);
  }, [buyingPower, effectiveBuyPrice]);

  const effectiveSellableQuantity = sellableQuantity ?? holdingQuantity ?? undefined;

  // "불러오는 중" 은 데이터 도착 전 전용.
  // capacity (buyingPower+currentPrice 또는 sellable) 가 하나라도 오면 loading 벗어나서
  // 실제 계산(또는 '—')을 표시.
  const buyCapacityReady = currentPrice !== undefined && currentPrice > 0 && buyingPower !== undefined;
  const sellCapacityReady = effectiveSellableQuantity !== undefined;

  // 손익분기는 가격·수수료만으로 결정되므로 side(매수/매도)와 무관하게 항상 계산해 노출한다.
  const buyBreakEvenHint = useMemo(() => {
    if (effectiveBuyPrice === undefined || effectiveBuyPrice <= 0) {
      return undefined;
    }
    return buildBuyBreakEvenHint(effectiveBuyPrice, commissionRatePercent);
  }, [commissionRatePercent, effectiveBuyPrice]);

  // 자동매매(AutoTradePanel)가 결정한 주문을 실행. 수량·지정가를 ref 로 동기 전달한 뒤 제출한다.
  const executeAutoOrder = (
    intendedSide: 'BUY' | 'SELL',
    quantity: number | undefined,
    limitPrice: number | undefined
  ) => {
    if (submitting) return;
    // 수량이 없으면 실행하지 않는다(버튼도 비활성). 토스트로 빠지지 않게 가드.
    if (quantity === undefined || quantity <= 0) return;

    const recPrice =
      limitPrice !== undefined && Number.isFinite(limitPrice) && limitPrice > 0 ? limitPrice : null;

    // 제출에 쓸 값은 ref 로 동기 전달 → requestSubmit 이 곧바로 handleSubmit 을 호출해도
    // state flush 를 기다리지 않아 "비율 선택" 토스트로 잘못 빠지지 않는다.
    pendingQuantityRef.current = quantity;
    pendingLimitPriceRef.current = recPrice;
    pendingSideRef.current = intendedSide;
    skipTakeProfitRef.current = true; // 자동매매 실행은 목표수익률 자동 매도 건너뜀

    // 폼 표시 반영(시각적): 적용된 사이드·수량·지정가를 보여준다. 제출 값은 위 ref 가 결정.
    setSide(intendedSide);
    setQuantity(formatOrderQuantity(quantity));
    if (recPrice !== null) {
      limitPriceManualRef.current = false;
      setPriceMode('limit');
      setPrice(priceInputValue(recPrice));
    }

    formRef.current?.requestSubmit();
  };

  // 직접 입력값(수량·가격)으로 실행. 자동매매와 달리 목표수익률 자동 매도 설정을 그대로 따른다.
  const executeManual = (intendedSide: 'BUY' | 'SELL') => {
    if (submitting) return;
    // 선택된 %를 실행하려는 사이드 기준으로 환산해 주문 수량 결정
    // (매수=주문가능 금액 기준, 매도=보유 수량 기준). 직접 입력 수량은 effectiveQuantity 로 폴백.
    pendingQuantityRef.current =
      intendedSide === 'BUY' ? (buyQuantityForPercent ?? null) : (sellQuantityForPercent ?? null);
    setSide(intendedSide);
    pendingSideRef.current = intendedSide;
    skipTakeProfitRef.current = false;
    formRef.current?.requestSubmit();
  };

  // 키보드 단축키(A/S)에서 최신 executeManual 을 호출하기 위한 ref (keydown effect 는 빈 deps).
  const executeManualRef = useRef(executeManual);
  executeManualRef.current = executeManual;

  const shortcutStateRef = useRef({
    side,
    quantity,
    sellableQuantity,
    effectiveSellableQuantity,
    maxBuyQuantity,
    useAmountOrder,
    submitting,
    priceMode,
    currentPrice,
  });

  shortcutStateRef.current = {
    side,
    quantity,
    sellableQuantity,
    effectiveSellableQuantity,
    maxBuyQuantity,
    useAmountOrder,
    submitting,
    priceMode,
    currentPrice,
  };

  // 커스텀 폼 수량은 사용자가 입력한 값만 사용한다.
  const effectiveQuantity = useMemo(() => {
    const parsed = Number(quantity);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }, [quantity]);

  // % 선택 시 예상 수량 — 매수는 주문가능 금액(maxBuyQuantity), 매도는 보유수량(effectiveSellableQuantity) 기준.
  const buyQuantityForPercent = useMemo(() => {
    if (selectedQuantityPercent === undefined || maxBuyQuantity === undefined || maxBuyQuantity <= 0) {
      return undefined;
    }
    const qty = quantityFromPercent(maxBuyQuantity, selectedQuantityPercent);
    return qty > 0 ? qty : undefined;
  }, [selectedQuantityPercent, maxBuyQuantity]);

  const sellQuantityForPercent = useMemo(() => {
    const sellable =
      effectiveSellableQuantity !== undefined ? Math.floor(effectiveSellableQuantity) : undefined;
    if (selectedQuantityPercent === undefined || sellable === undefined || sellable <= 0) {
      return undefined;
    }
    const qty = quantityFromPercent(sellable, selectedQuantityPercent);
    return qty > 0 ? qty : undefined;
  }, [selectedQuantityPercent, effectiveSellableQuantity]);

  // 예상 금액(현재가 기준) = 예상 수량 × 현재가. (% 미선택 시 직접 입력 수량으로 폴백)
  const buyEstimatedAmount = useMemo(() => {
    if (useAmountOrder || currentPrice === undefined || currentPrice <= 0) return undefined;
    const qty = buyQuantityForPercent ?? effectiveQuantity;
    return qty !== undefined ? qty * currentPrice : undefined;
  }, [useAmountOrder, currentPrice, buyQuantityForPercent, effectiveQuantity]);

  const sellEstimatedAmount = useMemo(() => {
    if (useAmountOrder || currentPrice === undefined || currentPrice <= 0) return undefined;
    const qty = sellQuantityForPercent ?? effectiveQuantity;
    return qty !== undefined ? qty * currentPrice : undefined;
  }, [useAmountOrder, currentPrice, sellQuantityForPercent, effectiveQuantity]);

  useEffect(() => {
    if (priceMode === 'current' && currentPrice !== undefined) {
      setPrice(String(currentPrice));
    }
  }, [currentPrice, priceMode]);

  // 지정가 기본값은 현재가(가격변동)를 따른다. 사용자가 직접 수정하면 추종 중단.
  useEffect(() => {
    if (priceMode !== 'limit' || currentPrice === undefined || limitPriceManualRef.current) {
      return;
    }

    setPrice(String(currentPrice));
  }, [priceMode, currentPrice]);

  const handlePriceModeChange = (mode: PriceMode) => {
    setPriceMode(mode);
    setStoredPriceMode(mode);

    if (mode === 'current' && currentPrice !== undefined) {
      limitPriceManualRef.current = false;
      setPrice(String(currentPrice));
      return;
    }

    if (mode === 'market') {
      limitPriceManualRef.current = false;
      setPrice('');
      return;
    }

    if (mode === 'limit') {
      limitPriceManualRef.current = false;
      if (currentPrice !== undefined) {
        setPrice(String(currentPrice));
      }
    }
  };

  // 가격 ± 틱 스테퍼: 현재 입력값(없으면 현재가) 기준 한 틱씩 조정. 지정가 모드로 전환.
  const stepPrice = (dir: 1 | -1) => {
    const base = Number(price) || currentPrice;
    if (base === undefined || !Number.isFinite(base) || base <= 0) return;
    const next = base + dir * tickSizeFor(base);
    if (next <= 0) return;
    if (priceMode !== 'limit') {
      setPriceMode('limit');
      setStoredPriceMode('limit');
    }
    limitPriceManualRef.current = true;
    setPrice(priceInputValue(next));
  };

  // 호가 패널의 가격 탭 → 지정가 모드로 전환 + 해당 가격 입력(빠른 지정가 주문).
  useEffect(() => {
    return subscribeLimitPriceSelect((p) => {
      setPriceMode('limit');
      setStoredPriceMode('limit');
      limitPriceManualRef.current = true;
      setPrice(priceInputValue(p));
    });
  }, []);

  const handlePriceModeChangeRef = useRef(handlePriceModeChange);
  handlePriceModeChangeRef.current = handlePriceModeChange;

  // 수량 인풋 제거: %만 선택한다. 실제 주문 수량은 실행(직접 매수/매도) 시 사이드별로 환산.
  const applyQuantityPercent = (percent: number) => {
    const next = selectedQuantityPercent === percent ? undefined : percent;
    setStoredQuantityPercent(next);
    setSelectedQuantityPercent(next);
  };

  const clearSelectedQuantityPercent = () => {
    setSelectedQuantityPercent(undefined);
  };

  // 매수(주문가능)·매도(보유) 어느 쪽이든 여력이 있으면 % 버튼 노출 (사이드 비의존)
  const showQuantityPercentButtons =
    (maxBuyQuantity !== undefined && maxBuyQuantity > 0) ||
    (effectiveSellableQuantity !== undefined && effectiveSellableQuantity > 0);

  const quantityPercentDisabled = !showQuantityPercentButtons;

  // 금액 주문으로 전환 시 % 선택 해제 (수량 주문에서만 % 의미 있음)
  useEffect(() => {
    if (useAmountOrder) clearSelectedQuantityPercent();
  }, [useAmountOrder]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (isEditableInputFocused()) return;

      const state = shortcutStateRef.current;
      if (state.submitting) return;

      const quantityPercent = getQuantityPercentFromKey(event);
      if (quantityPercent !== undefined) {
        if (state.useAmountOrder) return;
        event.preventDefault();
        setSelectedQuantityPercent(quantityPercent);
        return;
      }

      switch (event.code) {
        // A = 직접 매수, S = 직접 매도 (직매수/매도 실행 버튼과 동일하게 동작)
        case 'KeyA':
          event.preventDefault();
          executeManualRef.current('BUY');
          return;
        case 'KeyS':
          event.preventDefault();
          executeManualRef.current('SELL');
          return;
        case 'KeyW': {
          // 100% 선택
          if (state.useAmountOrder) return;
          event.preventDefault();
          setSelectedQuantityPercent(100);
          return;
        }
        case 'BracketLeft': {
          if (state.useAmountOrder) return;

          const nextMode = getAdjacentPriceMode(state.priceMode, -1, state.currentPrice);
          if (nextMode === state.priceMode) return;

          event.preventDefault();
          handlePriceModeChangeRef.current(nextMode);
          return;
        }
        case 'BracketRight': {
          if (state.useAmountOrder) return;

          const nextMode = getAdjacentPriceMode(state.priceMode, 1, state.currentPrice);
          if (nextMode === state.priceMode) return;

          event.preventDefault();
          handlePriceModeChangeRef.current(nextMode);
          return;
        }
        case 'Tab': {
          const form = formRef.current;
          if (!form) return;
          event.preventDefault();
          focusNextOrderFormField(form, event.shiftKey);
          return;
        }
        default:
          return;
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    // 실행 버튼으로만 매수/매도 결정 (상단 탭 제거)
    const effectiveSide = pendingSideRef.current ?? side;
    pendingSideRef.current = null;
    // 자동매매 실행 여부를 읽고 즉시 리셋 (이후 일반 제출엔 영향 없게)
    const skipTakeProfit = skipTakeProfitRef.current;
    skipTakeProfitRef.current = false;
    // 사이드별 %기준 수량(있으면) 우선, 없으면 직접 입력한 effectiveQuantity 사용.
    const pendingQuantity = pendingQuantityRef.current;
    pendingQuantityRef.current = null;
    // 자동매매 실행이 지정한 지정가(있으면 priceMode/price 상태 대신 이 값을 사용).
    const pendingLimitPrice = pendingLimitPriceRef.current;
    pendingLimitPriceRef.current = null;

    const payload: CreateOrderPayload = {
      symbol: symbol.toUpperCase(),
      side: effectiveSide,
      orderType: 'LIMIT',
      clientOrderId: crypto.randomUUID(),
    };

    if (useAmountOrder) {
      payload.orderAmount = Number(orderAmount);
      payload.orderType = 'MARKET';
    } else {
      const submitQuantity = pendingQuantity ?? effectiveQuantity;
      if (submitQuantity === undefined || submitQuantity <= 0) {
        showToast('비율(%)을 선택해 주세요.', 'error');
        return;
      }

      payload.quantity = submitQuantity;

      if (pendingLimitPrice !== null) {
        // 자동매매 실행: 지정한 지정가로 LIMIT 주문 (상태 flush 와 무관하게 정확한 값 사용)
        payload.orderType = 'LIMIT';
        payload.price = floorToTick(pendingLimitPrice);
      } else if (priceMode === 'market') {
        payload.orderType = 'MARKET';
      } else if (priceMode === 'current') {
        payload.orderType = 'LIMIT';
        payload.price = floorToTick(currentPrice);
      } else {
        payload.orderType = 'LIMIT';
        payload.price = floorToTick(Number(price || currentPrice));
      }
    }

    const submitOptions: OrderSubmitOptions | undefined =
      effectiveSide === 'BUY' && useTakeProfitSell && !useAmountOrder && !skipTakeProfit
        ? { takeProfitSell: { profitRatePercent: takeProfitRatePercent } }
        : undefined;

    if (submitOptions?.takeProfitSell) {
      const rate = submitOptions.takeProfitSell.profitRatePercent;
      if (!Number.isFinite(rate) || rate <= 0) {
        showToast('목표 실수익률을 올바르게 입력해 주세요.', 'error');
        return;
      }
    }

    setSubmitting(true);

    try {
      const result = await onSubmit(payload, submitOptions);

      showToast(formatOrderSuccessMessage(payload), 'success');

      if (result?.takeProfitSell?.message) {
        showToast(
          result.takeProfitSell.message,
          result.takeProfitSell.placed ? 'success' : 'error'
        );
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '주문에 실패했습니다.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  // 가격/주문금액 라벨과 같은 줄(우측)에 두는 금액 주문 토글 (두 모드 공통)
  const amountOrderToggle = (
    <label className="checkbox order-form__amount-toggle">
      <input
        type="checkbox"
        checked={useAmountOrder}
        onChange={(e) => setUseAmountOrder(e.target.checked)}
      />
      금액 주문
    </label>
  );

  return (
    <form
      ref={formRef}
      className="panel order-form"
      onSubmit={handleSubmit}
      onKeyDown={(event) => {
        // Enter 로는 주문을 실행하지 않는다(버튼 또는 A/S 단축키로만).
        // 입력창에서의 암묵적 폼 제출(금액 주문 단일 입력 등)도 차단.
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
          event.preventDefault();
        }
      }}
    >
      <div className="order-form__body">
        <div className="order-form__quote">
          <strong className="order-form__quote-price">
            {currentPrice !== undefined ? formatPrice(currentPrice, currency) : '—'}
          </strong>
          <span
            className={`order-form__quote-change${
              getKrProfitLossClass(dayChangeDiff) ? ` ${getKrProfitLossClass(dayChangeDiff)}` : ''
            }`}
          >
            {dayChange.value}
          </span>
        </div>

        <StockHoldingSummary
          variant="order"
          quantity={holdingQuantity}
          averagePrice={holdingAveragePrice}
          marketValue={holdingMarketValue}
          profitLoss={holdingProfitLoss}
          profitLossRate={holdingProfitLossRate}
          currency={currency}
        />

        {/* 국내주식 등 비(非)USD 종목은 조회 전용 — 주문 입력/실행 UI를 숨기고 안내만 노출 */}
        {!isOrderable && (
          <p className="order-form__readonly-notice hint">
            국내주식은 현재 조회 전용입니다(주문 준비 중). 시세·차트·보유 현황만 표시됩니다.
          </p>
        )}

        {/* 매수/매도 구분은 상단 탭이 아닌 하단 실행 버튼으로만 결정 (UX 개선) */}
        {/* 세미오토/오토 실행 중에는 주문 입력(가격·수량·목표매도)을 숨기고 자동 실행 내용만 노출 */}
        {isOrderable &&
          !autoExecActive &&
          (useAmountOrder ? (
          <div className="order-form__section">
            <div className="order-form__field-header">
              <span className="order-form__field-label">주문 금액 (USD)</span>
              {amountOrderToggle}
            </div>
            <label>
              <input
                type="text"
                inputMode="decimal"
                value={orderAmount}
                onChange={(e) => setOrderAmount(sanitizeDecimalInput(e.target.value))}
                required
              />
            </label>
          </div>
        ) : (
          <>
            <div className="order-form__section">
              <div className="order-form__field-header">
                <span className="order-form__field-label">가격</span>
                {amountOrderToggle}
              </div>
              <div className="order-price-row">
                <button
                  type="button"
                  className="order-price-step"
                  aria-label="한 틱 내리기"
                  onClick={() => stepPrice(-1)}
                  disabled={priceMode === 'market'}
                >
                  −
                </button>
                <input
                  type="text"
                  inputMode="decimal"
                  value={price}
                  placeholder={
                    priceMode === 'market' ? '시장가' : currentPrice ? String(currentPrice) : '0.00'
                  }
                  onChange={(e) => {
                    limitPriceManualRef.current = true;
                    setPrice(sanitizeDecimalInput(e.target.value));
                  }}
                  disabled={isPriceInputDisabled}
                  required={priceMode === 'limit'}
                />
                <button
                  type="button"
                  className="order-price-step"
                  aria-label="한 틱 올리기"
                  onClick={() => stepPrice(1)}
                  disabled={priceMode === 'market'}
                >
                  ＋
                </button>
              </div>

              <div className="order-quick-actions order-price-modes">
                <button
                  type="button"
                  className={priceMode === 'limit' ? 'active' : ''}
                  onClick={() => handlePriceModeChange('limit')}
                >
                  지정가
                </button>
                <button
                  type="button"
                  className={priceMode === 'current' ? 'active' : ''}
                  onClick={() => handlePriceModeChange('current')}
                  disabled={currentPrice === undefined}
                >
                  현재가
                </button>
                <button
                  type="button"
                  className={priceMode === 'market' ? 'active' : ''}
                  onClick={() => handlePriceModeChange('market')}
                >
                  시장가
                </button>
              </div>
            </div>

            <div className="order-form__section">
              <div className="order-form__section-title">수량 비율</div>
              {showQuantityPercentButtons && (
                <div className="order-quick-actions">
                  {QUANTITY_PERCENTAGES.map((percent) => (
                    <button
                      key={percent}
                      type="button"
                      className={selectedQuantityPercent === percent ? 'active' : ''}
                      onClick={() => applyQuantityPercent(percent)}
                      disabled={quantityPercentDisabled}
                    >
                      {percent}%
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="order-form__section">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={useTakeProfitSell}
                  onChange={(e) => setUseTakeProfitSell(e.target.checked)}
                />
                매수 후 평단가 기준 목표 실수익률 매도
              </label>

              {useTakeProfitSell && (
                <>
                  <div className="order-quick-actions">
                    {TAKE_PROFIT_RATE_OPTIONS.map((rate) => (
                      <button
                        key={rate}
                        type="button"
                        className={takeProfitRatePercent === rate ? 'active' : ''}
                        onClick={() => updateTakeProfitRate(rate)}
                      >
                        {rate}%
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </>
          ))}
      </div>

      <div className="order-form__submit-block">
        {/* 모바일 접힘 상태에서도 보유 요약(수량/평단/총가치)을 항상 노출. 데스크톱·모바일 펼침에서는
            order-form__body 의 요약이 보이므로 CSS 로 중복 표시를 막는다. */}
        <div className="order-form__sticky-holding">
          <StockHoldingSummary
            variant="order"
            quantity={holdingQuantity}
            averagePrice={holdingAveragePrice}
            marketValue={holdingMarketValue}
            profitLoss={holdingProfitLoss}
            profitLossRate={holdingProfitLossRate}
            currency={currency}
          />
        </div>

        {isOrderable && !autoExecActive && (
          <>
        {/* 매수 가능·손익분기·매도 가능·예상 금액은 side(매수/매도)와 무관하게 항상 노출 */}
        <div className="order-form__hints">
          <div className="order-form__buy-hints-row">
            <p className="hint order-form__footer-hint">
              매수 가능: {buyCapacityReady
                ? formatOrderQuantity(maxBuyQuantity ?? 0) + '주'
                : (buyingPower !== undefined || currentPrice !== undefined ? '—' : '불러오는 중...')}
            </p>
            {buyBreakEvenHint && (
              <>
                <span className="order-form__hint-divider">·</span>
                <p className="hint order-form__footer-hint">{buyBreakEvenHint}</p>
              </>
            )}
          </div>

          <p className="hint order-form__footer-hint">
            매도 가능: {sellCapacityReady && effectiveSellableQuantity !== undefined && effectiveSellableQuantity > 0
              ? `${effectiveSellableQuantity}주`
              : (sellCapacityReady ? '0주' : (effectiveSellableQuantity !== undefined ? '—' : '불러오는 중...'))}
          </p>

          {!useAmountOrder && (
            <>
              <p className="order-estimated-amount">
                예상 매수{' '}
                <strong>
                  {buyQuantityForPercent !== undefined
                    ? `${formatOrderQuantity(buyQuantityForPercent)}주${buyEstimatedAmount !== undefined ? ` · ${formatUsd(buyEstimatedAmount)}` : ''}`
                    : '—'}
                </strong>
              </p>
              <p className="order-estimated-amount sell">
                예상 매도{' '}
                <strong>
                  {sellQuantityForPercent !== undefined
                    ? `${formatOrderQuantity(sellQuantityForPercent)}주${sellEstimatedAmount !== undefined ? ` · ${formatUsd(sellEstimatedAmount)}` : ''}`
                    : '—'}
                </strong>
              </p>
            </>
          )}
        </div>

        {/* 직접 입력(수량·가격)으로 실행하는 버튼. 사용자가 정한 값 그대로 주문. */}
        <div className="order-manual-actions">
          <button
            type="button"
            className="order-manual-btn buy"
            onClick={() => executeManual('BUY')}
            disabled={submitting}
          >
            직접 매수
            {!quantity && selectedQuantityPercent !== undefined && (
              <span className="order-manual-btn__pct">{selectedQuantityPercent}%</span>
            )}
          </button>
          <button
            type="button"
            className="order-manual-btn sell"
            onClick={() => executeManual('SELL')}
            disabled={submitting}
          >
            직접 매도
            {!quantity && selectedQuantityPercent !== undefined && (
              <span className="order-manual-btn__pct">{selectedQuantityPercent}%</span>
            )}
          </button>
        </div>

          </>
        )}

        {/* 자동매매(드라이런/세미오토/오토). 데스크탑·모바일 + USD(미국주식)만. 세미오토는 확인 탭 후 실주문.
            모바일은 포그라운드+화면 켜짐에서만 동작(탭 숨김 시 일시정지) — 패널이 안내. */}
        {isOrderable && (
          <AutoTradePanel
            symbol={symbol}
            currentPrice={currentPrice}
            holding={holding}
            sellableQuantity={effectiveSellableQuantity}
            takeProfitRatePercent={takeProfitRatePercent}
            buyingPower={buyingPower}
            submitting={submitting}
            onAutoExecute={(side, qty, price) => executeAutoOrder(side, qty, price)}
            onExecModeChange={setAutoExecActive}
            isMobile={!isDesktop}
            candles={candles}
            candleInterval={candleInterval}
            bids={bids}
            asks={asks}
            previousClose={previousClose}
            maxBuyQuantity={maxBuyQuantity}
            openOrders={openOrders}
            currency={currency}
          />
        )}

      </div>
    </form>
  );
}

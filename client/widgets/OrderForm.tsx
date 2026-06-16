import { useEffect, useMemo, useRef, useState } from 'react';
import { StockHoldingSummary } from './StockHoldingSummary';
import { useToast } from '../app/providers/ToastContext';
import { buildBuyBreakEvenHint } from '../shared/lib/commissionBreakEven';
import { formatUsd } from '../shared/lib/formatHoldings';
import { TAKE_PROFIT_RATE_OPTIONS } from '../shared/lib/takeProfitRatePreference';
import { getStoredPriceMode, setStoredPriceMode } from '../shared/lib/priceModePreference';
import { useOrderRecommendations } from '../shared/hooks/useRecommendations';
import type { CandleInterval, ChartCandle, HoldingItem, Order } from '../shared/types';
import { formatOrderSuccessMessage } from '../shared/lib/formatOrderToast';
import type { LimitPriceRecommendation } from '../shared/lib/limitPriceRecommendation';
import type { CreateOrderPayload, OrderSubmitOptions, OrderSubmitResult } from '../shared/types';

type PriceMode = 'limit' | 'current' | 'market';

const QUANTITY_PERCENTAGES = [10, 25, 50, 75, 100] as const;

const PRICE_MODES = ['limit', 'current', 'market'] as const satisfies readonly PriceMode[];

interface OrderFormProps {
  symbol: string;
  currentPrice?: number;
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
  trades?: { price: number; quantity: number; timestamp: string }[];
  holding?: HoldingItem;
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
  trades = [],
  holding,
  openOrders = [],
  onSubmit,
}: OrderFormProps) {
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const pendingSideRef = useRef<'BUY' | 'SELL' | null>(null);
  // 추천 매수/매도 간편 실행 시에는 목표수익률 자동 매도를 건너뛴다(체크돼 있어도 미실행).
  const skipTakeProfitRef = useRef(false);
  // 제출 직전 결정된 주문 수량(사이드별 %기준). 설정돼 있으면 handleSubmit 이 이 값을 우선 사용.
  const pendingQuantityRef = useRef<number | null>(null);
  const [priceMode, setPriceMode] = useState<PriceMode>(getStoredPriceMode);
  const [quantity, setQuantity] = useState('');
  const [selectedQuantityPercent, setSelectedQuantityPercent] = useState<number>();
  const [price, setPrice] = useState('');
  const [orderAmount, setOrderAmount] = useState('');
  const [useAmountOrder, setUseAmountOrder] = useState(false);
  const [useTakeProfitSell, setUseTakeProfitSell] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [isMobileExpanded, setIsMobileExpanded] = useState(false);
  const { showToast } = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const limitPriceManualRef = useRef(false);

  // Reset form state when symbol changes (for navigation without full reload)
  // This ensures recommendations and inputs are fresh for the new symbol's data
  useEffect(() => {
    if (symbol) {
      setQuantity('');
      setSelectedQuantityPercent(undefined);
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

  const isPriceInputDisabled = priceMode === 'current' || priceMode === 'market';

  const effectiveOrderPrice = priceMode === 'limit' ? Number(price) || currentPrice : currentPrice;

  const effectiveBuyPrice = effectiveOrderPrice;

  const maxBuyQuantity = useMemo(() => {
    if (buyingPower === undefined || buyingPower <= 0) return undefined;
    if (effectiveBuyPrice === undefined || effectiveBuyPrice <= 0) return undefined;
    return getMaxBuyQuantity(buyingPower, effectiveBuyPrice);
  }, [buyingPower, effectiveBuyPrice]);

  const effectiveSellableQuantity = sellableQuantity ?? holdingQuantity ?? undefined;

  const buyMaxForRec = maxBuyQuantity;
  const sellMaxForRec =
    (effectiveSellableQuantity !== undefined && effectiveSellableQuantity > 0)
      ? Math.floor(effectiveSellableQuantity)
      : (holding && holding.quantity > 0 ? Math.floor(holding.quantity) : undefined);

  const maxOrderQuantity = useMemo(() => {
    if (side === 'BUY') return maxBuyQuantity;
    if (effectiveSellableQuantity === undefined || effectiveSellableQuantity <= 0) return undefined;
    return Math.floor(effectiveSellableQuantity);
  }, [maxBuyQuantity, effectiveSellableQuantity, side]);

  // Readiness for capacities and recommendations.
  // "불러오는 중" 은 데이터 도착 전 전용. 
  // capacity (buyingPower+currentPrice 또는 sellable) 가 하나라도 오면 loading 벗어나서
  // 실제 계산(또는 '—')을 표시. candles는 rec 품질에 도움되지만 blocking 하지 않음.
  const buyCapacityReady = currentPrice !== undefined && currentPrice > 0 && buyingPower !== undefined;
  const sellCapacityReady = effectiveSellableQuantity !== undefined;

  // rec 카드: capacity(계산에 필요한 max/price) 가 준비되면 rec 로직 실행.
  // (candles 없어도 build*Recommendation 은 기본 추천을 낼 수 있음. candles는 보정용.)
  const recInputsReady = buyCapacityReady || sellCapacityReady;

  // 손익분기는 가격·수수료만으로 결정되므로 side(매수/매도)와 무관하게 항상 계산해 노출한다.
  const buyBreakEvenHint = useMemo(() => {
    if (effectiveBuyPrice === undefined || effectiveBuyPrice <= 0) {
      return undefined;
    }
    return buildBuyBreakEvenHint(effectiveBuyPrice, commissionRatePercent);
  }, [commissionRatePercent, effectiveBuyPrice]);

  // 7개 주문 추천의 입력을 한 객체로 모은다. useMemo 로 안정화해 실제 의존성이 바뀔 때만
  // 워커에 새 계산을 요청한다.
  const recommendationInput = useMemo(
    () => ({
      side,
      currentPrice,
      candles,
      candleInterval,
      bids,
      asks,
      trades,
      holding,
      takeProfitRatePercent,
      commissionRatePercent,
      openOrders,
      effectiveOrderPrice,
      maxOrderQuantity,
      buyMaxForRec,
      sellMaxForRec,
      buyingPower,
    }),
    [
      asks,
      bids,
      buyMaxForRec,
      buyingPower,
      candleInterval,
      candles,
      commissionRatePercent,
      currentPrice,
      effectiveOrderPrice,
      holding,
      maxOrderQuantity,
      openOrders,
      sellMaxForRec,
      side,
      takeProfitRatePercent,
      trades,
    ]
  );

  // 7개 추천(지정가·수량·익절률, BUY/SELL 각각)을 단일 Web Worker 왕복으로 계산해
  // 메인 스레드를 계산에서 분리한다. 결과 도착 전까지는 직전 값을 유지(no-flicker)한다.
  // 커스텀(직접) 주문 폼은 추천 정보에 따라 바뀌지 않는다.
  // 추천 데이터는 오직 아래 '추천 매수/매도' 카드 내부 표시에만 사용한다.
  // (takeProfitRateRecommendation 은 별도 '목표 실수익률 매도' 추천 기능에서만 사용)
  const {
    takeProfitRateRecommendation,
    buyQuantityRec,
    sellQuantityRec,
    buyLimitPriceRec,
    sellLimitPriceRec,
  } = useOrderRecommendations(recommendationInput);

  // 추천 카드용 예상 금액 (해당 추천의 수량 × 추천 지정가)
  const recommendedBuyAmount =
    buyQuantityRec.available &&
    buyQuantityRec.quantity !== undefined &&
    buyLimitPriceRec.available &&
    buyLimitPriceRec.price !== undefined &&
    Number.isFinite(buyLimitPriceRec.price)
      ? buyQuantityRec.quantity * buyLimitPriceRec.price
      : undefined;

  const recommendedSellAmount =
    sellQuantityRec.available &&
    sellQuantityRec.quantity !== undefined &&
    sellLimitPriceRec.available &&
    sellLimitPriceRec.price !== undefined &&
    Number.isFinite(sellLimitPriceRec.price)
      ? sellQuantityRec.quantity * sellLimitPriceRec.price
      : undefined;

  const getDisplayedPrice = (
    limitRec: LimitPriceRecommendation | undefined,
    currPrice: number | undefined
  ) => {
    if (limitRec?.available && limitRec.price !== undefined && Number.isFinite(limitRec.price)) {
      return limitRec.price.toFixed(2);
    }
    if (currPrice !== undefined) {
      return currPrice.toFixed(2);
    }
    return null;
  };

  // 추천 정보로 간편 실행 (해당 사이드의 추천 수량 + 지정가 자동 적용 후 제출)
  const executeWithRecommendation = (intendedSide: 'BUY' | 'SELL') => {
    const isBuy = intendedSide === 'BUY';
    const qtyRec = isBuy ? buyQuantityRec : sellQuantityRec;
    const priceRec = isBuy ? buyLimitPriceRec : sellLimitPriceRec;

    setSide(intendedSide);

    setTimeout(() => {
      // 추천 수량 적용
      if (qtyRec.available && qtyRec.recommended && qtyRec.quantity !== undefined) {
        setQuantity(formatOrderQuantity(qtyRec.quantity));
        if (qtyRec.snapPercent) {
          setSelectedQuantityPercent(qtyRec.snapPercent);
        }
      }

      // 추천 지정가 적용
      if (priceRec.available && priceRec.price !== undefined && Number.isFinite(priceRec.price)) {
        limitPriceManualRef.current = false;
        setPriceMode('limit');
        setPrice(priceRec.price.toFixed(2));
      }

      // 제출 (추천 실행은 목표수익률 자동 매도 건너뜀)
      pendingSideRef.current = intendedSide;
      skipTakeProfitRef.current = true;
      formRef.current?.requestSubmit();
    }, 0);
  };

  // 직접 입력값(수량·가격)으로 실행. 추천과 달리 목표수익률 자동 매도 설정을 그대로 따른다.
  const executeManual = (intendedSide: 'BUY' | 'SELL') => {
    if (submitting) return;
    // 선택된 %를 실행하려는 사이드 기준으로 환산해 주문 수량 결정
    // (매수=주문가능 금액 기준, 매도=보유 수량 기준). 추천 등으로 설정된 수량은 effectiveQuantity 로 폴백.
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

  // 커스텀 폼 수량은 사용자가 입력한 값만 사용한다(추천 수량으로 폴백하지 않음).
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

  // 예상 금액(현재가 기준) = 예상 수량 × 현재가. (% 미선택 시 추천 등으로 설정된 수량으로 폴백)
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

  // 지정가 기본값은 추천이 아닌 현재가(가격변동)를 따른다. 사용자가 직접 수정하면 추종 중단.
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

  const handlePriceModeChangeRef = useRef(handlePriceModeChange);
  handlePriceModeChangeRef.current = handlePriceModeChange;

  // 수량 인풋 제거: %만 선택한다. 실제 주문 수량은 실행(직접 매수/매도) 시 사이드별로 환산.
  const applyQuantityPercent = (percent: number) => {
    setSelectedQuantityPercent((prev) => (prev === percent ? undefined : percent));
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
    // 추천 실행 여부를 읽고 즉시 리셋 (이후 일반 제출엔 영향 없게)
    const skipTakeProfit = skipTakeProfitRef.current;
    skipTakeProfitRef.current = false;
    // 사이드별 %기준 수량(있으면) 우선, 없으면 추천 등으로 설정된 effectiveQuantity 사용.
    const pendingQuantity = pendingQuantityRef.current;
    pendingQuantityRef.current = null;

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
        showToast('비율(%)을 선택하거나 추천 실행을 사용해 주세요.', 'error');
        return;
      }

      payload.quantity = submitQuantity;

      if (priceMode === 'market') {
        payload.orderType = 'MARKET';
      } else if (priceMode === 'current') {
        payload.orderType = 'LIMIT';
        payload.price = currentPrice;
      } else {
        payload.orderType = 'LIMIT';
        payload.price = Number(price || currentPrice);
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

  // Mobile: 핸들바로 주문폼 전체 펼치기/접기
  const toggleMobileExpanded = () => setIsMobileExpanded((v) => !v);

  useEffect(() => {
    const column = document.querySelector('.order-column') as HTMLElement | null;
    if (!column) return;
    column.classList.toggle('order-column--mobile-expanded', isMobileExpanded);
  }, [isMobileExpanded]);

  return (
    <form
      ref={formRef}
      className={`panel order-form ${isMobileExpanded ? 'is-mobile-expanded' : ''}`}
      onSubmit={handleSubmit}
      onKeyDown={(event) => {
        // Enter 로는 주문을 실행하지 않는다(버튼 또는 A/S 단축키로만).
        // 입력창에서의 암묵적 폼 제출(금액 주문 단일 입력 등)도 차단.
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
          event.preventDefault();
        }
      }}
    >
      {/* 모바일 플로팅 주문폼용 핸들바: 탭하면 전체 주문폼(입력/요약 등) 보였다/숨겼다 */}
      <div
        className="order-form__mobile-handlebar"
        onClick={toggleMobileExpanded}
        role="button"
        tabIndex={0}
        aria-label={isMobileExpanded ? '주문폼 접기' : '주문폼 펼치기'}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleMobileExpanded();
          }
        }}
      >
        <div className="order-form__mobile-handlebar-grip" />
      </div>

      <div className="order-form__body">
        <StockHoldingSummary
          variant="order"
          quantity={holdingQuantity}
          averagePrice={holdingAveragePrice}
          marketValue={holdingMarketValue}
          profitLoss={holdingProfitLoss}
          profitLossRate={holdingProfitLossRate}
        />

        {/* 매수/매도 구분은 상단 탭이 아닌 하단 실행 버튼으로만 결정 (UX 개선) */}

        <label className="checkbox">
          <input
            type="checkbox"
            checked={useAmountOrder}
            onChange={(e) => setUseAmountOrder(e.target.checked)}
          />
          금액 주문 (USD, 정규장만)
        </label>

        {useAmountOrder ? (
          <label>
            주문 금액 (USD)
            <input
              type="number"
              min="0"
              step="0.01"
              value={orderAmount}
              onChange={(e) => setOrderAmount(e.target.value)}
              required
            />
          </label>
        ) : (
          <>
            <div className="order-form__section">
              <label>
                가격
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={price}
                  placeholder={
                    priceMode === 'market' ? '시장가' : currentPrice ? String(currentPrice) : '0.00'
                  }
                  onChange={(e) => {
                    limitPriceManualRef.current = true;
                    setPrice(e.target.value);
                  }}
                  disabled={isPriceInputDisabled}
                  required={priceMode === 'limit'}
                />
              </label>

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
              <div className="order-form__section-title">목표 실수익률 매도 (선택)</div>
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
                  <label>
                    목표 실수익률 (세금·수수료 반영, %)
                    <input
                      type="number"
                      min="0.1"
                      step="0.1"
                      value={takeProfitRatePercent}
                      onChange={(e) => updateTakeProfitRate(Number(e.target.value))}
                      required
                    />
                  </label>
                  <div className="order-quick-actions">
                    {TAKE_PROFIT_RATE_OPTIONS.map((rate) => (
                      <button
                        key={rate}
                        type="button"
                        className={
                          takeProfitRatePercent === rate
                            ? 'active'
                            : takeProfitRateRecommendation.rate === rate
                              ? 'is-suggested'
                              : ''
                        }
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
        )}
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
          />
        </div>

        {/* 매수 가능·손익분기·매도 가능·예상 금액은 side(매수/매도)나 추천 상황과 무관하게 항상 노출 */}
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

        {/* 직접 입력(수량·가격)으로 실행하는 버튼. 추천 카드와 별개로 사용자가 정한 값 그대로 주문.
            기본적으로 추천 실행 버튼 위에 배치한다. */}
        <div className="order-manual-actions">
          <button
            type="button"
            className="order-manual-btn buy"
            onClick={() => executeManual('BUY')}
            disabled={submitting}
          >
            직접 매수
          </button>
          <button
            type="button"
            className="order-manual-btn sell"
            onClick={() => executeManual('SELL')}
            disabled={submitting}
          >
            직접 매도
          </button>
        </div>

        {/* 추천 매수/매도 카드를 좌우 배치, 라벨 아래에 정보 세로 나열 (클릭 영역은 카드 전체) */}
        {/* async 데이터(currentPrice, buyingPower, candles, bids/asks 등) 도착 전에는 '불러오는 중...' 표시.
            데이터 도착 후에야 quantity/limit rec 계산이 유효한 입력으로 동작하고, 추천 또는 합당한 '—' 를 표시. */}
        <div className="order-rec-grid">
          <div
            className={`order-rec-row buy ${(submitting || !recInputsReady || !(buyQuantityRec.available && buyQuantityRec.recommended && buyQuantityRec.quantity !== undefined)) ? 'is-disabled' : ''}`}
            onClick={() => !submitting && recInputsReady && (buyQuantityRec.available && buyQuantityRec.recommended && buyQuantityRec.quantity !== undefined) && executeWithRecommendation('BUY')}
            role="button"
            tabIndex={(submitting || !recInputsReady || !(buyQuantityRec.available && buyQuantityRec.recommended && buyQuantityRec.quantity !== undefined)) ? -1 : 0}
          >
            <span className="rec-label">추천 매수</span>
            <span className="rec-info">
              {!recInputsReady
                ? '불러오는 중...'
                : (buyQuantityRec.available && buyQuantityRec.recommended && buyQuantityRec.quantity !== undefined
                  ? `${formatOrderQuantity(buyQuantityRec.quantity)}주${getDisplayedPrice(buyLimitPriceRec, currentPrice) ? ` @ $${getDisplayedPrice(buyLimitPriceRec, currentPrice)}` : ''}`
                  : '—')}
            </span>
            {recommendedBuyAmount !== undefined && recInputsReady && (
              <span className="rec-expected">예상 금액 {formatUsd(recommendedBuyAmount)}</span>
            )}
          </div>

          <div
            className={`order-rec-row sell ${(submitting || !recInputsReady || !(sellQuantityRec.available && sellQuantityRec.recommended && sellQuantityRec.quantity !== undefined)) ? 'is-disabled' : ''}`}
            onClick={() => !submitting && recInputsReady && (sellQuantityRec.available && sellQuantityRec.recommended && sellQuantityRec.quantity !== undefined) && executeWithRecommendation('SELL')}
            role="button"
            tabIndex={(submitting || !recInputsReady || !(sellQuantityRec.available && sellQuantityRec.recommended && sellQuantityRec.quantity !== undefined)) ? -1 : 0}
          >
            <span className="rec-label">추천 매도</span>
            <span className="rec-info">
              {!recInputsReady
                ? '불러오는 중...'
                : (sellQuantityRec.available && sellQuantityRec.recommended && sellQuantityRec.quantity !== undefined
                  ? `${formatOrderQuantity(sellQuantityRec.quantity)}주${getDisplayedPrice(sellLimitPriceRec, currentPrice) ? ` @ $${getDisplayedPrice(sellLimitPriceRec, currentPrice)}` : ''}`
                  : '—')}
            </span>
            {recommendedSellAmount !== undefined && recInputsReady && (
              <span className="rec-expected">예상 금액 {formatUsd(recommendedSellAmount)}</span>
            )}
          </div>
        </div>

      </div>
    </form>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { StockHoldingSummary } from './StockHoldingSummary';
import { useToast } from '../app/providers/ToastContext';
import { buildBuyBreakEvenHint } from '../shared/lib/commissionBreakEven';
import { formatUsd } from '../shared/lib/formatHoldings';
import { buildLimitPriceRecommendation } from '../shared/lib/limitPriceRecommendation';
import { buildOrderPriceModeRecommendation } from '../shared/lib/orderPriceModeRecommendation';
import {
  buildOrderQuantityRecommendation,
  formatQuantityRecommendationValue,
  resolveOrderQuantity,
} from '../shared/lib/orderQuantityRecommendation';
import { TAKE_PROFIT_RATE_OPTIONS } from '../shared/lib/takeProfitRatePreference';
import { buildTakeProfitRateRecommendation } from '../shared/lib/takeProfitRateRecommendation';
import type { CandleInterval, ChartCandle, HoldingItem, Order } from '../shared/types';
import { formatOrderSuccessMessage } from '../shared/lib/formatOrderToast';
import { ORDER_SIDE_LABEL } from '../shared/lib/labels';
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

function quantityFromAvailablePercent(
  side: 'BUY' | 'SELL',
  maxBuyQuantity: number | undefined,
  sellableQuantity: number | undefined,
  percent: number
) {
  if (side === 'BUY') {
    if (maxBuyQuantity === undefined || maxBuyQuantity <= 0) return undefined;
    return formatOrderQuantity(quantityFromPercent(maxBuyQuantity, percent));
  }

  if (sellableQuantity === undefined || sellableQuantity <= 0) return undefined;
  return formatOrderQuantity(quantityFromPercent(sellableQuantity, percent));
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
  const [priceMode, setPriceMode] = useState<PriceMode>('limit');
  const [quantity, setQuantity] = useState('');
  const [selectedQuantityPercent, setSelectedQuantityPercent] = useState<number>();
  const [price, setPrice] = useState('');
  const [orderAmount, setOrderAmount] = useState('');
  const [useAmountOrder, setUseAmountOrder] = useState(false);
  const [useTakeProfitSell, setUseTakeProfitSell] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const { showToast } = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const limitPriceManualRef = useRef(false);

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

  const maxOrderQuantity = useMemo(() => {
    if (side === 'BUY') return maxBuyQuantity;
    if (sellableQuantity === undefined || sellableQuantity <= 0) return undefined;
    return Math.floor(sellableQuantity);
  }, [maxBuyQuantity, sellableQuantity, side]);

  const buyBreakEvenHint = useMemo(() => {
    if (side !== 'BUY' || effectiveBuyPrice === undefined || effectiveBuyPrice <= 0) {
      return undefined;
    }
    return buildBuyBreakEvenHint(effectiveBuyPrice, commissionRatePercent);
  }, [commissionRatePercent, effectiveBuyPrice, side]);

  const limitPriceRecommendation = useMemo(
    () =>
      buildLimitPriceRecommendation({
        side,
        currentPrice,
        candles,
        candleInterval,
        bids,
        asks,
        trades,
        holding,
        targetProfitRatePercent: takeProfitRatePercent,
        commissionRatePercent,
        openOrders,
      }),
    [
      asks,
      bids,
      candleInterval,
      candles,
      commissionRatePercent,
      currentPrice,
      holding,
      openOrders,
      side,
      takeProfitRatePercent,
      trades,
    ]
  );

  const takeProfitRateRecommendation = useMemo(
    () =>
      buildTakeProfitRateRecommendation({
        candles,
        currentPrice,
        bids,
        asks,
      }),
    [asks, bids, candles, currentPrice]
  );

  const quantityRecommendation = useMemo(
    () =>
      buildOrderQuantityRecommendation({
        side,
        unitPrice: effectiveOrderPrice,
        maxQuantity: maxOrderQuantity,
        buyingPower,
        candles,
        bids,
        asks,
        trades,
        holding,
        openOrders,
      }),
    [
      asks,
      bids,
      buyingPower,
      candles,
      effectiveOrderPrice,
      holding,
      maxOrderQuantity,
      openOrders,
      side,
      trades,
    ]
  );

  const recommendedLimitPriceText =
    limitPriceRecommendation.available &&
    limitPriceRecommendation.price !== undefined &&
    Number.isFinite(limitPriceRecommendation.price)
      ? limitPriceRecommendation.price.toFixed(2)
      : undefined;

  const applyRecommendedLimitPrice = () => {
    if (!recommendedLimitPriceText) return;

    limitPriceManualRef.current = false;
    setPriceMode('limit');
    setPrice(recommendedLimitPriceText);
  };

  // 추천 정보로 간편 실행 (수량 + 지정가 추천 적용 후 제출)
  // 하단 버튼에서 사용. 인풋에 보여주는 추천은 제거했으므로 여기서만 적용
  const executeWithRecommendation = (intendedSide: 'BUY' | 'SELL') => {
    setSide(intendedSide);

    // state 업데이트 후 memos가 갱신되도록 약간 지연 후 적용 + 제출
    setTimeout(() => {
      // 추천 수량 적용
      if (
        quantityRecommendation.available &&
        quantityRecommendation.recommended &&
        quantityRecommendation.quantity !== undefined
      ) {
        setQuantity(formatOrderQuantity(quantityRecommendation.quantity));
        if (quantityRecommendation.snapPercent) {
          setSelectedQuantityPercent(quantityRecommendation.snapPercent);
        }
      }

      // 추천 지정가 적용
      if (
        limitPriceRecommendation.available &&
        limitPriceRecommendation.price !== undefined &&
        Number.isFinite(limitPriceRecommendation.price)
      ) {
        limitPriceManualRef.current = false;
        setPriceMode('limit');
        setPrice(limitPriceRecommendation.price.toFixed(2));
      }

      // 제출
      pendingSideRef.current = intendedSide;
      formRef.current?.requestSubmit();
    }, 0);
  };

  const shortcutStateRef = useRef({
    side,
    quantity,
    sellableQuantity,
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
    maxBuyQuantity,
    useAmountOrder,
    submitting,
    priceMode,
    currentPrice,
  };

  const effectiveQuantity = useMemo(
    () => resolveOrderQuantity(quantity, quantityRecommendation),
    [quantity, quantityRecommendation]
  );

  const estimatedBuyAmount =
    side === 'BUY' &&
    !useAmountOrder &&
    currentPrice !== undefined &&
    effectiveQuantity !== undefined
      ? effectiveQuantity * currentPrice
      : undefined;

  const quantityRecommendationRef = useRef(quantityRecommendation);
  quantityRecommendationRef.current = quantityRecommendation;

  useEffect(() => {
    limitPriceManualRef.current = false;
    setQuantity('');
    setSelectedQuantityPercent(undefined);
  }, [side, symbol]);

  useEffect(() => {
    if (priceMode === 'current' && currentPrice !== undefined) {
      setPrice(String(currentPrice));
    }
  }, [currentPrice, priceMode]);

  useEffect(() => {
    if (priceMode !== 'limit' || !recommendedLimitPriceText || limitPriceManualRef.current) {
      return;
    }

    setPrice(recommendedLimitPriceText);
  }, [priceMode, recommendedLimitPriceText]);

  const handlePriceModeChange = (mode: PriceMode) => {
    setPriceMode(mode);

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
      if (recommendedLimitPriceText) {
        setPrice(recommendedLimitPriceText);
      }
    }
  };

  const handlePriceModeChangeRef = useRef(handlePriceModeChange);
  handlePriceModeChangeRef.current = handlePriceModeChange;

  const applyQuantityPercent = (percent: number) => {
    const nextQuantity = quantityFromAvailablePercent(
      side,
      maxBuyQuantity,
      sellableQuantity,
      percent
    );
    if (nextQuantity === undefined) return;
    setSelectedQuantityPercent(percent);
    setQuantity(nextQuantity);
  };

  const applyRecommendedTakeProfitRate = () => {
    if (!takeProfitRateRecommendation.available) return;
    updateTakeProfitRate(takeProfitRateRecommendation.rate);
  };

  const applyRecommendedQuantity = () => {
    if (
      !quantityRecommendation.available ||
      !quantityRecommendation.recommended ||
      quantityRecommendation.quantity === undefined
    ) {
      return;
    }

    setQuantity(formatOrderQuantity(quantityRecommendation.quantity));
    setSelectedQuantityPercent(quantityRecommendation.snapPercent);
  };

  const clearSelectedQuantityPercent = () => {
    setSelectedQuantityPercent(undefined);
  };

  const showQuantityPercentButtons =
    side === 'BUY' ? maxBuyQuantity !== undefined : sellableQuantity !== undefined;

  const quantityPercentDisabled =
    side === 'BUY'
      ? maxBuyQuantity === undefined || maxBuyQuantity <= 0
      : sellableQuantity === undefined || sellableQuantity <= 0;

  const adjustQuantity = (delta: number) => {
    const {
      side: currentSide,
      quantity: currentQuantity,
      sellableQuantity: sellable,
      maxBuyQuantity: maxBuy,
      useAmountOrder: amountOrder,
    } = shortcutStateRef.current;
    if (amountOrder) return;

    const parsed = Number(currentQuantity);
    let base =
      Number.isFinite(parsed) && parsed > 0
        ? parsed
        : (quantityRecommendationRef.current.quantity ?? 0);
    let next = base + delta;
    next = Math.max(1, next);

    if (currentSide === 'BUY' && maxBuy !== undefined) {
      next = Math.min(next, maxBuy);
    }

    if (currentSide === 'SELL' && sellable !== undefined) {
      next = Math.min(next, Math.floor(sellable));
    }

    clearSelectedQuantityPercent();
    setQuantity(formatOrderQuantity(next));
  };

  useEffect(() => {
    clearSelectedQuantityPercent();
  }, [side, useAmountOrder]);

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

        const nextQuantity = quantityFromAvailablePercent(
          state.side,
          state.maxBuyQuantity,
          state.sellableQuantity,
          quantityPercent
        );
        if (nextQuantity === undefined) return;

        event.preventDefault();
        setSelectedQuantityPercent(quantityPercent);
        setQuantity(nextQuantity);
        return;
      }

      switch (event.code) {
        // A/S 키는 상단 탭이 제거되었으므로 매수/매도 모드 전환으로는 더 이상 사용하지 않음
        // (실행 버튼으로 직접 결정)
        case 'Minus':
        case 'NumpadSubtract':
          event.preventDefault();
          adjustQuantity(-1);
          return;
        case 'Equal':
        case 'NumpadAdd':
          event.preventDefault();
          adjustQuantity(1);
          return;
        case 'KeyW': {
          const nextQuantity = quantityFromAvailablePercent(
            state.side,
            state.maxBuyQuantity,
            state.sellableQuantity,
            100
          );
          if (nextQuantity === undefined) return;

          event.preventDefault();
          setSelectedQuantityPercent(100);
          setQuantity(nextQuantity);
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
        case 'Enter':
          event.preventDefault();
          formRef.current?.requestSubmit();
          return;
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
      const submitQuantity = resolveOrderQuantity(quantity, quantityRecommendation);
      if (submitQuantity === undefined) {
        showToast('수량을 입력하거나 추천 수량을 확인해 주세요.', 'error');
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
      effectiveSide === 'BUY' && useTakeProfitSell && !useAmountOrder
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

  const submitWithSide = (intendedSide: 'BUY' | 'SELL') => {
    pendingSideRef.current = intendedSide;
    // side 상태를 업데이트해서 추천 계산 등이 최신화되도록 (선택)
    setSide(intendedSide);
    formRef.current?.requestSubmit();
  };

  return (
    <form ref={formRef} className="panel order-form" onSubmit={handleSubmit}>
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
              <div className="order-form__section-title">수량</div>
              <label>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={quantity}
                  placeholder="수량"
                  onChange={(e) => {
                    clearSelectedQuantityPercent();
                    setQuantity(e.target.value);
                  }}
                />
              </label>

              {showQuantityPercentButtons && (
                <div className="order-quick-actions">
                  {QUANTITY_PERCENTAGES.map((percent) => (
                    <button
                      key={percent}
                      type="button"
                      className={
                        selectedQuantityPercent === percent
                          ? 'active'
                          : quantityRecommendation.snapPercent === percent
                            ? 'is-suggested'
                            : ''
                      }
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
              <div className="order-form__section-title">가격</div>
              <label>
                지정가 (USD)
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
                  <div className="order-insight order-insight--compact order-take-profit-recommendation">
                    <span className="order-insight__title">추천 목표</span>
                    <strong className="order-insight__value">
                      {takeProfitRateRecommendation.rateLabel}
                    </strong>
                    <button
                      type="button"
                      className="order-insight__apply"
                      onClick={applyRecommendedTakeProfitRate}
                      disabled={!takeProfitRateRecommendation.available || submitting}
                    >
                      적용
                    </button>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>

      <div className="order-form__submit-block">
        <div className="order-form__hints">
          {side === 'BUY' && maxBuyQuantity !== undefined && (
            <p className="hint order-form__footer-hint">
              매수 가능: {formatOrderQuantity(maxBuyQuantity)}주
            </p>
          )}

          {buyBreakEvenHint && <p className="hint order-form__footer-hint">{buyBreakEvenHint}</p>}

          {side === 'SELL' && sellableQuantity !== undefined && (
            <p className="hint order-form__footer-hint">매도 가능: {sellableQuantity}주</p>
          )}

          {estimatedBuyAmount !== undefined && (
            <p className="order-estimated-amount">
              예상 매수 금액 <strong>{formatUsd(estimatedBuyAmount)}</strong>
            </p>
          )}
        </div>

        {/* 하단에 추천 수량 + 추천 지정가 종합 표시 + 추천 실행 버튼 */}
        <div className="order-rec-summary">
          <div className="order-rec-summary__label">추천 실행</div>
          <div className="order-rec-summary__values">
            <span>
              수량{' '}
              <strong>
                {quantityRecommendation.available && quantityRecommendation.quantity !== undefined
                  ? formatOrderQuantity(quantityRecommendation.quantity)
                  : '—'}
              </strong>
            </span>
            <span className="divider">·</span>
            <span>
              지정가{' '}
              <strong>
                {limitPriceRecommendation.available &&
                limitPriceRecommendation.price !== undefined &&
                Number.isFinite(limitPriceRecommendation.price)
                  ? limitPriceRecommendation.price.toFixed(2)
                  : '—'}
              </strong>
            </span>
          </div>
        </div>

        <div className="order-execute-actions">
          <button
            type="button"
            className="buy-btn"
            onClick={() => executeWithRecommendation('BUY')}
            disabled={submitting}
          >
            {submitting ? '제출 중…' : '추천 매수'}
          </button>
          <button
            type="button"
            className="sell-btn"
            onClick={() => executeWithRecommendation('SELL')}
            disabled={submitting}
          >
            {submitting ? '제출 중…' : '추천 매도'}
          </button>
        </div>

        <div className="order-manual-hint">
          <span className="hint">수량/가격을 직접 조정한 후에는 Enter 키로 실행하세요.</span>
        </div>
      </div>
    </form>
  );
}

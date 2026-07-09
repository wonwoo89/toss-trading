const EVENT_NAME = 'toss-trading:set-limit-price';

/**
 * 호가 패널의 가격 탭 → 주문폼 지정가 입력으로 전달하는 경량 이벤트 버스.
 * OrderbookPanel(MarketPanel 내부)과 OrderForm 은 서로 다른 컬럼이라 props 로 잇기엔
 * 경유(훅→두 props bag)가 길어, window CustomEvent 로 단방향 전달한다.
 */
export function emitLimitPriceSelect(price: number) {
  if (!Number.isFinite(price) || price <= 0) return;
  window.dispatchEvent(new CustomEvent<number>(EVENT_NAME, { detail: price }));
}

export function subscribeLimitPriceSelect(handler: (price: number) => void): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<number>).detail;
    if (Number.isFinite(detail) && detail > 0) handler(detail);
  };
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}

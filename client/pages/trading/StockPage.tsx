import { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { MarketPanel } from '../../widgets/MarketPanel';
import { OrderForm } from '../../widgets/OrderForm';
import { PortfolioSidebar } from '../../widgets/PortfolioSidebar';

import { useAppContext, useRequireAccountSeq } from '../../app/providers/AppContext';
import { HOLDINGS_POLL_MS, useSymbolTrading } from '../../shared/hooks/useSymbolTrading';

import type { CreateOrderPayload, OrderSubmitOptions, OrderSubmitResult } from '../../shared/types';

export function StockPage() {
  // 1. 상태(state) or hook
  const { symbol: routeSymbol } = useParams<{ symbol?: string }>();
  const symbol = routeSymbol?.toUpperCase();
  const hasSymbol = Boolean(symbol);
  const { isReady, selectedAccountSeq, setBuyingPower, setTotalMarketValue, buyingPower } =
    useAppContext();
  const requireAccountSeq = useRequireAccountSeq();

  const layoutRef = useRef<HTMLElement>(null);

  const {
    portfolioHoldings,
    portfolioOpenOrders,
    cancelOrder,
    submitOrder,
    refreshPortfolioHoldings,
    refreshPortfolioOpenOrders,
    refreshBuyingPower,
    portfolioTotals,
    refreshMarketNow,
    refreshCandlesNow,
    marketPanelProps,
    orderFormProps,
  } = useSymbolTrading({
    symbol,
    accountSeq: selectedAccountSeq,
    setBuyingPower,
    setTotalMarketValue,
  });

  // 3. 함수 (메소드 & 핸들러) - get/set/on/handle 접두사로 목적 명확히

  const handleCreateOrder = async (
    payload: CreateOrderPayload,
    options?: OrderSubmitOptions
  ): Promise<OrderSubmitResult> => {
    requireAccountSeq(); // 계좌 선택 확인 (훅 내부에서 에러 throw)

    const result = await submitOrder(payload, options, {
      refreshMarketNow,
      refreshCandlesNow,
      refreshBuyingPower,
      refreshPortfolioHoldings,
      refreshPortfolioOpenOrders,
    });

    return result;
  };

  const handleCancelOrder = async (orderId: string) => {
    requireAccountSeq(); // 계좌 확인 (에러 throw 목적)
    await cancelOrder(orderId);
  };

  // 4. useEffect (side effect 로직은 return 직전)
  // 포트폴리오 오픈오더 초기 로드는 훅 내부 또는 다른 곳에서 (initial phase 가드 적용됨)

  useEffect(() => {
    const searchInput = document.getElementById('symbol-search');
    if (searchInput instanceof HTMLElement) {
      searchInput.blur();
    }
    layoutRef.current?.focus({ preventScroll: true });
  }, [symbol]);

  return (
    <>
      <main
        ref={layoutRef}
        className={`trading-layout${hasSymbol ? '' : ' trading-layout--portfolio-only'}`}
        tabIndex={-1}
      >
        <div className="trading-layout__main">
          {hasSymbol && symbol ? (
            <>
              <MarketPanel {...marketPanelProps} />
              <section className="order-column">
                <OrderForm {...orderFormProps} onSubmit={handleCreateOrder} />
              </section>
            </>
          ) : (
            <section className="trading-welcome panel">
              <h2>내 포트폴리오</h2>
              <p className="hint">
                우측 보유 종목을 선택하거나 상단 검색으로 종목을 고르면 차트와 주문 화면이 열립니다.
              </p>
            </section>
          )}
        </div>
        <PortfolioSidebar
          buyingPower={buyingPower}
          totalMarketValue={portfolioTotals.totalMarketValue}
          totalProfitLoss={portfolioTotals.totalProfitLoss}
          totalProfitLossRate={portfolioTotals.totalProfitLossRate}
          holdings={portfolioHoldings}
          openOrders={portfolioOpenOrders}
          activeSymbol={symbol}
          holdingsPollIntervalMs={HOLDINGS_POLL_MS}
          holdingsRefreshing={false}
          onCancelOrder={handleCancelOrder}
        />
      </main>
    </>
  );
}

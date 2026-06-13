import { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { MarketPanel } from '../../widgets/MarketPanel';
import { OrderForm } from '../../widgets/OrderForm';
import { PortfolioSidebar } from '../../widgets/PortfolioSidebar';

import { useAppContext } from '../../app/providers/AppContext';
import { HOLDINGS_POLL_MS, useTrading } from '../../features/trade';


export function StockPage() {
  // 1. 상태(state) or hook
  const { symbol: routeSymbol } = useParams<{ symbol?: string }>();
  const symbol = routeSymbol?.toUpperCase();
  const hasSymbol = Boolean(symbol);
  const { selectedAccountSeq, setBuyingPower, setTotalMarketValue, buyingPower } =
    useAppContext();

  const layoutRef = useRef<HTMLElement>(null);

  const {
    portfolioHoldings,
    portfolioOpenOrders,
    createOrder,
    cancelOrder,
    portfolioTotals,
    marketPanelProps,
    orderFormProps,
  } = useTrading({
    symbol,
    accountSeq: selectedAccountSeq,
    setBuyingPower,
    setTotalMarketValue,
  });

  // 4. useEffect (side effect 로직은 return 직전)
  // (focus 관련은 UI 관심사로 page에 남겨둠)

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
                <OrderForm {...orderFormProps} onSubmit={createOrder} />
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
          onCancelOrder={cancelOrder}
        />
      </main>
    </>
  );
}

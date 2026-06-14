import { useRef } from 'react';
import { useParams } from 'react-router-dom';
import { MarketPanel } from '../../widgets/MarketPanel';
import { OrderForm } from '../../widgets/OrderForm';
import { PortfolioSidebar } from '../../widgets/PortfolioSidebar';

import { useAppContext } from '../../app/providers/AppContext';
import { HOLDINGS_POLL_MS, useTrading, useFocusOnSymbol } from '../../features/trade';

export function StockPage() {
  // 1. 상태(state) or hook
  const { symbol: routeSymbol } = useParams<{ symbol?: string }>();
  const symbol = routeSymbol?.toUpperCase();
  const hasSymbol = Boolean(symbol);
  const { selectedAccountSeq, setBuyingPower, setTotalMarketValue, buyingPower } = useAppContext();

  const layoutRef = useRef<HTMLElement | null>(null);

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

  useFocusOnSymbol(symbol, layoutRef);

  return (
    <>
      <main
        ref={layoutRef}
        className={`trading-layout${hasSymbol ? '' : ' trading-layout--portfolio-only'}`}
        tabIndex={-1}
      >
        <div className="trading-layout__main">
          {hasSymbol && symbol ? (
            <MarketPanel key={symbol} {...marketPanelProps} symbol={symbol} />
          ) : null}
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
        {hasSymbol && symbol ? (
          <section className="order-column">
            <OrderForm key={symbol} {...orderFormProps} symbol={symbol} onSubmit={createOrder} />
          </section>
        ) : null}
      </main>
    </>
  );
}

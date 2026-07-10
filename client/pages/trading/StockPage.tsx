import { useRef, useState, useSyncExternalStore } from 'react';
import { useParams } from 'react-router-dom';
import { MarketPanel } from '../../widgets/MarketPanel';
import { OrderForm } from '../../widgets/OrderForm';
import { PortfolioSidebar } from '../../widgets/PortfolioSidebar';
import { HoldingsChipBar } from '../../widgets/HoldingsChipBar';
import { MobileTabBar, type MobileTab } from '../../widgets/MobileTabBar';

import { useAppContext } from '../../app/providers/AppContext';
import { HOLDINGS_POLL_MS, useTrading, useFocusOnSymbol } from '../../features/trade';
import {
  getMobileLayoutV2,
  subscribeMobileLayout,
} from '../../shared/lib/mobileLayoutPreference';

export function StockPage() {
  // 1. 상태(state) or hook
  const { symbol: routeSymbol } = useParams<{ symbol?: string }>();
  const symbol = routeSymbol?.toUpperCase();
  const hasSymbol = Boolean(symbol);
  const { selectedAccountSeq, setBuyingPower, setTotalMarketValue, buyingPower } = useAppContext();

  const layoutRef = useRef<HTMLElement | null>(null);

  // 모바일 신규 레이아웃(v2, 하단 탭). 헤더 토글로 전환 — 커스텀 이벤트로 동기화.
  const mobileV2 = useSyncExternalStore(subscribeMobileLayout, getMobileLayoutV2);
  const [mobileTab, setMobileTab] = useState<MobileTab>('chart');

  const {
    visibleHoldings,
    hiddenHoldings,
    toggleHiddenSymbol,
    portfolioOpenOrders,
    createOrder,
    cancelOrder,
    portfolioTotals,
    holdingsRefreshing,
    marketPanelProps,
    orderFormProps,
  } = useTrading({
    symbol,
    accountSeq: selectedAccountSeq,
    setBuyingPower,
    setTotalMarketValue,
  });

  useFocusOnSymbol(symbol, layoutRef);

  const v2Active = mobileV2 && hasSymbol;
  const layoutClass = [
    'trading-layout',
    hasSymbol ? '' : 'trading-layout--portfolio-only',
    v2Active ? `layout-v2 layout-v2--tab-${mobileTab}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <main ref={layoutRef} className={layoutClass} tabIndex={-1}>
        <div className="trading-layout__main">
          {hasSymbol && symbol ? (
            <>
              <HoldingsChipBar holdings={visibleHoldings} activeSymbol={symbol} />
              <MarketPanel key={symbol} {...marketPanelProps} symbol={symbol} />
            </>
          ) : null}
        </div>
        <PortfolioSidebar
          buyingPower={buyingPower}
          totalMarketValue={portfolioTotals.totalMarketValue}
          totalProfitLoss={portfolioTotals.totalProfitLoss}
          totalProfitLossRate={portfolioTotals.totalProfitLossRate}
          holdings={visibleHoldings}
          hiddenHoldings={hiddenHoldings}
          onToggleHidden={toggleHiddenSymbol}
          openOrders={portfolioOpenOrders}
          activeSymbol={symbol}
          holdingsPollIntervalMs={HOLDINGS_POLL_MS}
          holdingsRefreshing={holdingsRefreshing}
          onCancelOrder={cancelOrder}
        />
        {hasSymbol && symbol ? (
          <section className="order-column">
            <OrderForm key={symbol} {...orderFormProps} symbol={symbol} onSubmit={createOrder} />
          </section>
        ) : null}
      </main>
      {v2Active && <MobileTabBar active={mobileTab} onChange={setMobileTab} />}
    </>
  );
}

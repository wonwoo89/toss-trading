import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useParams } from 'react-router-dom';
import { MarketPanel } from '../../widgets/MarketPanel';
import { OrderForm } from '../../widgets/OrderForm';
import { PortfolioSidebar } from '../../widgets/PortfolioSidebar';
import { HoldingsChipBar } from '../../widgets/HoldingsChipBar';
import { AccountSummaryCard } from '../../widgets/AccountSummaryCard';
import { MobileSettingsPanel } from '../../widgets/MobileSettingsPanel';
import { MobileTabBar, type MobileTab } from '../../widgets/MobileTabBar';
import { SymbolSearch } from '../../widgets/SymbolSearch';

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

  // v2 활성 시 전역(헤더 숨김 등) 스타일 스위치 — body 클래스. 언마운트/비활성 시 해제.
  useEffect(() => {
    document.body.classList.toggle('mobile-v2-active', v2Active);
    return () => document.body.classList.remove('mobile-v2-active');
  }, [v2Active]);

  // 검색 탭에서 종목을 선택하면(라우트 변경) 차트 탭으로 자동 전환.
  const prevSymbolRef = useRef(symbol);
  useEffect(() => {
    if (prevSymbolRef.current !== symbol) {
      prevSymbolRef.current = symbol;
      setMobileTab((tab) => (tab === 'search' ? 'chart' : tab));
    }
  }, [symbol]);
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
        {v2Active && (
          <>
            {/* 자산 탭 상단: '내 계좌'(총계좌·환율) — 드롭다운 없이 항상 펼쳐 표시 */}
            <div className="mobile-assets-extras">
              <AccountSummaryCard />
            </div>
            {/* 검색 탭: 헤더에서 이동한 종목 검색 */}
            <section className="mobile-search-panel" aria-label="종목 검색">
              <SymbolSearch />
            </section>
            {/* 설정 탭: 테마·화면꺼짐방지·레이아웃 전환·백테스트 */}
            <MobileSettingsPanel />
          </>
        )}
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

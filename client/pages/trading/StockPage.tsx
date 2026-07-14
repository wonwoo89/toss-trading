import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { MarketPanel } from '../../widgets/MarketPanel';
import { OrderForm } from '../../widgets/OrderForm';
import { PortfolioSidebar } from '../../widgets/PortfolioSidebar';
import { HoldingsChipBar } from '../../widgets/HoldingsChipBar';
import { AccountSummaryCard } from '../../widgets/AccountSummaryCard';
import { MobileSettingsPanel } from '../../widgets/MobileSettingsPanel';
import { MobileTabBar, type MobileTab } from '../../widgets/MobileTabBar';
import { SymbolSearch } from '../../widgets/SymbolSearch';
import { RecentSearchChips } from '../../widgets/RecentSearchChips';
import { getLastSelectedSymbol, setLastSelectedSymbol } from '../../shared/lib/lastSymbolPreference';

import { useAppContext } from '../../app/providers/AppContext';
import { useToast } from '../../app/providers/ToastContext';
import { HOLDINGS_POLL_MS, useTrading, useFocusOnSymbol } from '../../features/trade';
import { floorToTick } from '../../shared/lib/usTick';
import { formatOrderSuccessMessage } from '../../shared/lib/formatOrderToast';
import type { CreateOrderPayload } from '../../shared/types';

export function StockPage() {
  // 1. 상태(state) or hook
  const { symbol: routeSymbol } = useParams<{ symbol?: string }>();
  const symbol = routeSymbol?.toUpperCase();
  const hasSymbol = Boolean(symbol);
  const { selectedAccountSeq, setBuyingPower, setTotalMarketValue, buyingPower } = useAppContext();

  const layoutRef = useRef<HTMLElement | null>(null);
  const navigate = useNavigate();

  // 모바일 레이아웃은 하단 탭(구 v2)으로 고정 — 이전 레이아웃 제거.
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

  // 자동매매(차트 영역 상주) — 주문은 OrderForm 을 거치지 않고 createOrder 로 직결.
  // 세미오토/오토 활성 시 수동 주문(OrderForm)을 잠근다.
  const { showToast } = useToast();
  const [autoTradeActive, setAutoTradeActive] = useState(false);
  const [autoSubmitting, setAutoSubmitting] = useState(false);
  const executeAutoOrder = async (side: 'BUY' | 'SELL', quantity: number, limitPrice?: number) => {
    if (!symbol || autoSubmitting || quantity <= 0) return;
    const payload: CreateOrderPayload = {
      symbol,
      side,
      orderType: 'LIMIT',
      quantity,
      clientOrderId: crypto.randomUUID(),
    };
    if (limitPrice !== undefined && Number.isFinite(limitPrice) && limitPrice > 0) {
      payload.price = floorToTick(limitPrice);
    } else {
      payload.orderType = 'MARKET';
    }
    setAutoSubmitting(true);
    try {
      // 목표수익률 자동 매도 옵션 없이 주문만 — 자동매매의 익절/손절 트리거가 출구를 담당.
      await createOrder(payload);
      showToast(formatOrderSuccessMessage(payload), 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '주문에 실패했습니다.', 'error');
    } finally {
      setAutoSubmitting(false);
    }
  };

  const v2Active = hasSymbol;

  // 심볼 없이 진입(/ 또는 /portfolio)하면 마지막 선택 종목(없으면 보유 첫 종목)으로 자동 이동.
  useEffect(() => {
    if (hasSymbol) return;
    const target = getLastSelectedSymbol() || visibleHoldings[0]?.symbol;
    if (target) navigate(`/stock/${target.toUpperCase()}`, { replace: true });
  }, [hasSymbol, visibleHoldings, navigate]);

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
              <MarketPanel
                key={symbol}
                {...marketPanelProps}
                symbol={symbol}
                onAutoExecute={executeAutoOrder}
                autoSubmitting={autoSubmitting}
                onAutoExecModeChange={setAutoTradeActive}
              />
            </>
          ) : null}
        </div>
        {v2Active && (
          <>
            {/* 자산 탭 상단: '내 계좌'(총계좌·환율) — 드롭다운 없이 항상 펼쳐 표시 */}
            <div className="mobile-assets-extras">
              <AccountSummaryCard />
            </div>
            {/* 검색 탭: 헤더에서 이동한 종목 검색 + 최근 검색 칩(탭하면 주문 화면으로) */}
            <section className="mobile-search-panel" aria-label="종목 검색">
              <SymbolSearch />
              <RecentSearchChips
                onSelect={(sym) => {
                  setMobileTab('order'); // 검색 탭 → 주문 탭 (symbol 변경 효과보다 먼저 확정)
                  setLastSelectedSymbol(sym);
                  navigate(`/stock/${sym}`);
                }}
              />
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
            <OrderForm
              key={symbol}
              {...orderFormProps}
              symbol={symbol}
              autoTradeActive={autoTradeActive}
              onSubmit={createOrder}
            />
          </section>
        ) : null}
      </main>
      {v2Active && <MobileTabBar active={mobileTab} onChange={setMobileTab} />}
    </>
  );
}

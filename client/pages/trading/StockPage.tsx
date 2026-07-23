import { useEffect, useRef, useState } from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { MarketPanel } from '../../widgets/MarketPanel';
import { OrderForm } from '../../widgets/OrderForm';
import { OrderbookPanel } from '../../widgets/OrderbookPanel';
import { PortfolioSidebar } from '../../widgets/PortfolioSidebar';
import { HoldingsChipBar } from '../../widgets/HoldingsChipBar';
import { AccountSummaryCard } from '../../widgets/AccountSummaryCard';
import { MobileSettingsPanel } from '../../widgets/MobileSettingsPanel';
import { ServerAiPage } from '../server-ai/ServerAiPage';
import { MobileTabBar, type MobileTab } from '../../widgets/MobileTabBar';
import { SymbolSearch } from '../../widgets/SymbolSearch';
import { RecentSearchChips } from '../../widgets/RecentSearchChips';
import { getLastSelectedSymbol, setLastSelectedSymbol } from '../../shared/lib/lastSymbolPreference';
import {
  clampOrderbookSplitRatio,
  clearStoredOrderbookSplitRatio,
  getStoredOrderbookSplitRatio,
  setStoredOrderbookSplitRatio,
} from '../../shared/lib/orderbookSplitPreference';

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
  // 자동매매 '로그 보기'(모바일 v2): AI 탭으로 전환하면서 임베디드 전체 로그 모달을 1회 연다.
  const [aiLogRequest, setAiLogRequest] = useState(false);
  // 검색은 탭이 아니라 티커칩 바 좌측 돋보기 → 전체화면 오버레이.
  const [searchOpen, setSearchOpen] = useState(false);
  const searchOpenRef = useRef(false);
  searchOpenRef.current = searchOpen;

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
  // AI 매매(오토) 활성 여부는 주문폼 안내 문구에 사용.
  const { showToast } = useToast();
  const [autoTradeActive, setAutoTradeActive] = useState(false);
  const [autoSubmitting, setAutoSubmitting] = useState(false);
  const executeAutoOrder = async (
    side: 'BUY' | 'SELL',
    quantity: number,
    limitPrice?: number,
    orderAmount?: number
  ) => {
    const amountBuy = side === 'BUY' && orderAmount !== undefined && orderAmount > 0;
    if (!symbol || autoSubmitting || (!amountBuy && quantity <= 0)) return;
    const payload: CreateOrderPayload = {
      symbol,
      side,
      orderType: 'LIMIT',
      clientOrderId: crypto.randomUUID(),
    };
    if (amountBuy) {
      // 금액(달러) 시장가 매수 — 배정 금액이 1주 미만일 때의 소수점 매수(토스 지원 경로).
      payload.orderAmount = orderAmount;
      payload.orderType = 'MARKET';
    } else {
      payload.quantity = quantity;
      // 토스 제약: 소수점 수량 주문은 미국 주식 '시장가 매도'에서만 허용된다.
      // 정규장 소수점 전량 매도(손절/익절/트레일링/AI 매도)가 지정가로 나가면 거절되므로
      // 소수점 매도는 시장가로 강제한다(트리거 시점 현재가 부근에서 즉시 체결).
      const fractionalSell = side === 'SELL' && !Number.isInteger(quantity);
      if (
        !fractionalSell &&
        limitPrice !== undefined &&
        Number.isFinite(limitPrice) &&
        limitPrice > 0
      ) {
        payload.price = floorToTick(limitPrice);
      } else {
        payload.orderType = 'MARKET';
      }
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

  // 데스크톱 주문 컬럼: 주문폼(위)/호가(아래) 사이 드래그 핸들로 높이 비율 조절(localStorage 영속).
  // null = 조절한 적 없음 → 기본 레이아웃(주문폼 자연 높이, 호가가 나머지).
  // 저장값은 '호가 비율'(핸들 아래쪽 영역) — 핸들을 내리면 호가가 줄고 주문폼이 늘어난다.
  const orderColumnRef = useRef<HTMLElement | null>(null);
  const [orderbookRatio, setOrderbookRatio] = useState<number | null>(getStoredOrderbookSplitRatio);
  const draggingRatioRef = useRef<number | null>(null);

  const handleSplitPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const column = orderColumnRef.current;
    if (!column || event.button !== 0) return;
    event.preventDefault();
    const rect = column.getBoundingClientRect();
    if (rect.height <= 0) return;
    document.body.classList.add('is-row-resizing');
    const onMove = (ev: PointerEvent) => {
      // 포인터 위치는 '핸들 위쪽(주문폼) 비율' — 저장값은 호가 비율이므로 반전.
      const ratio = clampOrderbookSplitRatio(1 - (ev.clientY - rect.top) / rect.height);
      draggingRatioRef.current = ratio;
      setOrderbookRatio(ratio);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('is-row-resizing');
      if (draggingRatioRef.current !== null) {
        setStoredOrderbookSplitRatio(draggingRatioRef.current);
        draggingRatioRef.current = null;
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  // 더블클릭 = 기본 레이아웃으로 리셋, 화살표 키 = ±5%p 미세 조절(접근성).
  const resetSplit = () => {
    clearStoredOrderbookSplitRatio();
    setOrderbookRatio(null);
  };
  const handleSplitKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    // ↑ = 핸들을 위로(주문폼 축소 = 호가 확대), ↓ = 반대.
    const delta = event.key === 'ArrowUp' ? 0.05 : -0.05;
    setOrderbookRatio((current) => {
      const next = clampOrderbookSplitRatio((current ?? 0.4) + delta);
      setStoredOrderbookSplitRatio(next);
      return next;
    });
  };

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

  // 검색 오버레이에서 종목을 선택하면(라우트 변경) 오버레이를 닫고 주문 탭으로 전환.
  const prevSymbolRef = useRef(symbol);
  useEffect(() => {
    if (prevSymbolRef.current !== symbol) {
      prevSymbolRef.current = symbol;
      if (searchOpenRef.current) {
        setSearchOpen(false);
        setMobileTab('order');
      }
    }
  }, [symbol]);

  // 검색 오버레이 열림 중 배경 스크롤 잠금.
  useEffect(() => {
    if (!searchOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [searchOpen]);
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
              <HoldingsChipBar
                holdings={visibleHoldings}
                activeSymbol={symbol}
                onSearchClick={() => setSearchOpen(true)}
              />
              <MarketPanel
                key={symbol}
                {...marketPanelProps}
                symbol={symbol}
                onAutoExecute={executeAutoOrder}
                autoSubmitting={autoSubmitting}
                onViewAiLogs={
                  v2Active
                    ? () => {
                        setMobileTab('ai');
                        setAiLogRequest(true);
                      }
                    : undefined
                }
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
            {/* AI 매매 탭: 단일 종목(라이브)+백그라운드(페이퍼) 관리(임베드) — 탭 활성 시에만 마운트해 폴링 절약 */}
            <section className="mobile-serverai-panel" aria-label="AI 매매">
              {mobileTab === 'ai' && (
                <ServerAiPage
                  embedded
                  openLiveLog={aiLogRequest}
                  onLiveLogConsumed={() => setAiLogRequest(false)}
                />
              )}
            </section>
            {/* 설정 탭: 테마·화면꺼짐방지·레이아웃 전환·백테스트 */}
            <MobileSettingsPanel />
          </>
        )}
        <PortfolioSidebar
          onNavigateToStock={() => setMobileTab('order')}
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
          <section
            ref={orderColumnRef}
            className={`order-column${orderbookRatio !== null ? ' order-column--split' : ''}`}
            style={
              orderbookRatio !== null
                ? ({ '--orderbook-ratio': orderbookRatio } as CSSProperties)
                : undefined
            }
          >
            <OrderForm
              key={symbol}
              {...orderFormProps}
              symbol={symbol}
              autoTradeActive={autoTradeActive}
              onSubmit={createOrder}
            />
            {/* 데스크톱 전용 리사이즈 핸들 — 드래그로 주문폼/호가 비율 조절, 더블클릭 리셋 */}
            <div
              className="order-split-handle"
              role="separator"
              aria-orientation="horizontal"
              aria-label="주문폼·호가 높이 조절 (드래그, ↑↓ 키, 더블클릭=초기화)"
              tabIndex={0}
              title="드래그해서 주문/호가 높이 조절 · 더블클릭하면 초기화"
              onPointerDown={handleSplitPointerDown}
              onDoubleClick={resetSplit}
              onKeyDown={handleSplitKeyDown}
            />
            {/* 호가 — 데스크톱은 주문폼 아래 별도 섹션, 모바일은 호가 탭 전용.
                (MarketPanel 좌측 하단에서 이동 — 호가 심도가 늘어도 차트 높이를 잠식하지 않게) */}
            <div className="orderbook-section">
              <OrderbookPanel
                bids={marketPanelProps.bids ?? []}
                asks={marketPanelProps.asks ?? []}
                trades={marketPanelProps.trades ?? []}
                currency={marketPanelProps.currency}
                previousClose={marketPanelProps.previousClose}
                candles={marketPanelProps.candles}
                candleInterval={marketPanelProps.candleInterval}
              />
            </div>
          </section>
        ) : null}
      </main>
      {v2Active && <MobileTabBar active={mobileTab} onChange={setMobileTab} />}

      {/* 전체화면 종목 검색 오버레이(모바일) — 티커칩 바의 돋보기로 진입 */}
      {searchOpen && (
        <div className="mobile-search-overlay" role="dialog" aria-modal="true" aria-label="종목 검색">
          <div className="mobile-search-overlay__head">
            <div className="mobile-search-overlay__field">
              <SymbolSearch />
            </div>
            <button
              type="button"
              className="mobile-search-overlay__close"
              onClick={() => setSearchOpen(false)}
              aria-label="닫기"
            >
              ✕
            </button>
          </div>
          <RecentSearchChips
            onSelect={(sym) => {
              setSearchOpen(false);
              setMobileTab('order');
              setLastSelectedSymbol(sym);
              navigate(`/stock/${sym}`);
            }}
          />
        </div>
      )}
    </>
  );
}

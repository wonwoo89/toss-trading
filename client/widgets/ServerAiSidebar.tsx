import { useAppContext } from '../app/providers/AppContext';
import { HOLDINGS_POLL_MS, useTrading } from '../features/trade';
import { PortfolioSidebar } from './PortfolioSidebar';

/**
 * AI 매매 페이지 우측 포트폴리오 사이드바 — 트레이딩 페이지와 동일한 데이터/컴포넌트.
 * 주문 가능 금액·총 투자 금액·보유 종목·미체결 주문을 종목과 무관하게(포트폴리오 전용) 보여준다.
 * 종목 클릭 시 트레이딩 화면(/stock/:symbol)으로 이동한다.
 */
export function ServerAiSidebar() {
  const { selectedAccountSeq, setBuyingPower, setTotalMarketValue, buyingPower } = useAppContext();
  const {
    visibleHoldings,
    hiddenHoldings,
    toggleHiddenSymbol,
    portfolioOpenOrders,
    portfolioTotals,
    holdingsRefreshing,
    cancelOrder,
  } = useTrading({
    accountSeq: selectedAccountSeq,
    setBuyingPower,
    setTotalMarketValue,
  });

  return (
    <PortfolioSidebar
      buyingPower={buyingPower}
      totalMarketValue={portfolioTotals.totalMarketValue}
      totalProfitLoss={portfolioTotals.totalProfitLoss}
      totalProfitLossRate={portfolioTotals.totalProfitLossRate}
      holdings={visibleHoldings}
      hiddenHoldings={hiddenHoldings}
      onToggleHidden={toggleHiddenSymbol}
      openOrders={portfolioOpenOrders}
      holdingsPollIntervalMs={HOLDINGS_POLL_MS}
      holdingsRefreshing={holdingsRefreshing}
      onCancelOrder={cancelOrder}
    />
  );
}

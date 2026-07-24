import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { OpenOrdersPanel } from './OpenOrdersPanel';
import { PortfolioStats } from './PortfolioStats';
import { StockLabel } from './StockLabel';
import { useAutomatedSymbols } from '../shared/hooks/useAutomatedSymbols';
import { MarketBriefingModal } from './MarketBriefingModal';
import { api } from '../shared/api/client';
import { getBriefingExtras } from '../shared/lib/briefingExtras';
import { Typography } from '../shared/ui/Typography';
import { formatProfitLoss, formatUsd, getKrProfitLossClass } from '../shared/lib/formatHoldings';
import type { HoldingItem, Order } from '../shared/types';

interface PortfolioSidebarProps {
  /** 보유 종목 클릭으로 종목 이동 시 호출 — 모바일에서 차트 탭 전환에 사용. */
  onNavigateToStock?: (symbol: string) => void;
  buyingPower?: number;
  totalMarketValue?: number;
  totalProfitLoss?: number;
  totalProfitLossRate?: number;
  holdings: HoldingItem[];
  hiddenHoldings?: HoldingItem[];
  onToggleHidden?: (symbol: string) => void;
  openOrders: Order[];
  activeSymbol?: string;
  holdingsPollIntervalMs?: number;
  holdingsRefreshing?: boolean;
  onCancelOrder: (orderId: string) => Promise<void>;
}

export function PortfolioSidebar({
  onNavigateToStock,
  buyingPower,
  totalMarketValue,
  totalProfitLoss,
  totalProfitLossRate,
  holdings,
  hiddenHoldings = [],
  onToggleHidden,
  openOrders,
  activeSymbol,
  holdingsPollIntervalMs = 5000,
  holdingsRefreshing,
  onCancelOrder,
}: PortfolioSidebarProps) {
  // AI 자동매매(단일/다중) 실행 중 종목 — 티커 좌상단 ★ 표시용(30초 폴링).
  const automatedSymbols = useAutomatedSymbols();

  // AI 브리핑 — 접속(보유 목록 확보) 시 백그라운드로 1회 요청해 서버 캐시를 데워 두고,
  // 모달을 열면 캐시가 즉시 뜬다. 갱신은 모달 안의 버튼으로.
  const [briefingOpen, setBriefingOpen] = useState(false);
  const briefingWarmedRef = useRef(false);
  useEffect(() => {
    if (briefingWarmedRef.current || holdings.length === 0) return;
    briefingWarmedRef.current = true;
    const warmSymbols = [...new Set([...holdings.map((h) => h.symbol.toUpperCase()), ...getBriefingExtras()])];
    void api.getAiBriefing(warmSymbols).catch(() => undefined);
  }, [holdings]);
  const navigate = useNavigate();
  const [showHidden, setShowHidden] = useState(false);

  // 보유 종목 가치/PL 실시간 flash (UI/UX)
  const prevValuesRef = useRef<Record<string, number>>({});
  const [flashes, setFlashes] = useState<Record<string, 'up' | 'down'>>({});

  useEffect(() => {
    const nextFlashes: Record<string, 'up' | 'down'> = {};
    holdings.forEach((item) => {
      const prev = prevValuesRef.current[item.symbol];
      const curr = item.marketValue ?? 0;
      if (prev != null && curr !== prev) {
        nextFlashes[item.symbol] = curr > prev ? 'up' : 'down';
      }
      prevValuesRef.current[item.symbol] = curr;
    });

    if (Object.keys(nextFlashes).length > 0) {
      setFlashes(nextFlashes);
      const t = setTimeout(() => setFlashes({}), 700);
      return () => clearTimeout(t);
    }
  }, [holdings]);

  const onNavigateToStockRef = useRef(onNavigateToStock);
  onNavigateToStockRef.current = onNavigateToStock;

  const goToStock = (symbol: string) => {
    onNavigateToStock?.(symbol);
    navigate(`/stock/${symbol}`);
  };

  // Option(Alt) + 1~9 로 보이는 보유종목(표시 순서)으로 빠르게 이동.
  // 입력창 포커스 중에는 무시(다른 단축키와 동일 정책). holdings 는 폴링으로 자주 바뀌므로
  // ref 로 최신값만 참조해 리스너를 재바인딩하지 않는다.
  const holdingsRef = useRef(holdings);
  holdingsRef.current = holdings;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.metaKey || event.ctrlKey) return;

      const match = event.code.match(/^Digit([1-9])$/);
      if (!match) return;

      const active = document.activeElement;
      const isInputFocused =
        active instanceof HTMLElement &&
        (active.isContentEditable ||
          active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.tagName === 'SELECT');
      if (isInputFocused) return;

      const target = holdingsRef.current[Number(match[1]) - 1];
      if (!target) return;

      event.preventDefault();
      onNavigateToStockRef.current?.(target.symbol);
      navigate(`/stock/${target.symbol}`);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigate]);

  return (
    <aside className="portfolio-sidebar">
      <section className="panel portfolio-sidebar__summary">
        <PortfolioStats
          buyingPower={buyingPower}
          totalMarketValue={totalMarketValue}
          totalProfitLoss={totalProfitLoss}
          totalProfitLossRate={totalProfitLossRate}
        />
      </section>
      {briefingOpen && (
        <MarketBriefingModal
          symbols={holdings.map((h) => h.symbol)}
          onClose={() => setBriefingOpen(false)}
        />
      )}

      <section className="panel portfolio-sidebar__holdings">
        <div className="panel-title">
          {/* 타이틀 + AI 브리핑 버튼을 한 그룹으로 — 좌측에 나란히, 갱신 표시는 우측 유지 */}
          <div className="panel-title__group">
            <Typography size={20} as="h2">보유 종목</Typography>
            {holdings.length > 0 && (
              <button
                type="button"
                className="portfolio-briefing-btn"
                onClick={() => setBriefingOpen(true)}
                title="보유 종목 뉴스·공시 AI 브리핑"
              >
                AI 브리핑
              </button>
            )}
          </div>
          <Typography size={14} className="price-meta">
            <span
              className={`refresh-dot${holdingsRefreshing ? ' is-active' : ''}`}
              aria-hidden={!holdingsRefreshing}
            />
            {holdingsPollIntervalMs / 1000}초마다 갱신
          </Typography>
        </div>

        <div className="panel-body portfolio-holdings-list">
          {holdings.length === 0 ? (
            <Typography size={14} as="p" className="hint">보유한 미국 주식이 없습니다.</Typography>
          ) : (
            <ul className="portfolio-holdings-list__items">
              {holdings.map((item, index) => {
                const isActive = item.symbol.toUpperCase() === activeSymbol?.toUpperCase();
                // Option+1~9 단축키와 대응하는 번호 뱃지(상위 9개, 데스크톱 전용).
                const hotkey = index < 9 ? index + 1 : undefined;

                return (
                  <li key={item.symbol} className="portfolio-holding-row">
                    <button
                      type="button"
                      className={`portfolio-holding-item${isActive ? ' is-active' : ''}`}
                      onClick={() => goToStock(item.symbol)}
                    >
                      <div className="portfolio-holding-item__main">
                        <span className="portfolio-holding-item__label-group">
                          {hotkey !== undefined && (
                            <Typography
                              size={10}
                              className="portfolio-holding-item__hotkey"
                              aria-hidden="true"
                              title={`Option+${hotkey} 로 이동`}
                            >
                              {hotkey}
                            </Typography>
                          )}
                          <StockLabel symbol={item.symbol} starred={automatedSymbols.has(item.symbol.toUpperCase())} />
                        </span>
                        <Typography
                          size={14}
                          className={`portfolio-holding-item__value ${flashes[item.symbol] ? `price-flash-${flashes[item.symbol]}` : ''}`}
                        >
                          {formatUsd(item.marketValue)}
                        </Typography>
                      </div>
                      <div className="portfolio-holding-item__meta">
                        <Typography size={12} className="portfolio-holding-item__qty">
                          {item.quantity.toLocaleString('en-US', {
                            maximumFractionDigits: 4,
                          })}
                          주
                        </Typography>
                        <Typography
                          size={12}
                          className={`portfolio-holding-item__pl ${getKrProfitLossClass(item.profitLoss) ?? ''}`}
                        >
                          {formatProfitLoss(item.profitLoss, item.profitLossRate)}
                        </Typography>
                      </div>
                    </button>
                    {onToggleHidden && (
                      <button
                        type="button"
                        className="portfolio-holding-hide"
                        title="자산에서 숨기기"
                        aria-label={`${item.symbol} 자산에서 숨기기`}
                        onClick={() => onToggleHidden(item.symbol)}
                      >
                        숨기기
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {hiddenHoldings.length > 0 && (
            <div className="portfolio-hidden">
              <button
                type="button"
                className="portfolio-hidden__toggle"
                onClick={() => setShowHidden((prev) => !prev)}
                aria-expanded={showHidden}
              >
                <Typography size={12}>숨긴 종목 {hiddenHoldings.length}개</Typography>
                <Typography size={12} className="portfolio-hidden__chevron">
                  {showHidden ? '▾' : '▸'}
                </Typography>
              </button>

              {showHidden && (
                <ul className="portfolio-holdings-list__items portfolio-hidden__items">
                  {hiddenHoldings.map((item) => {
                    const isActive = item.symbol.toUpperCase() === activeSymbol?.toUpperCase();

                    return (
                      <li key={item.symbol} className="portfolio-holding-row">
                        <button
                          type="button"
                          className={`portfolio-holding-item is-hidden${isActive ? ' is-active' : ''}`}
                          onClick={() => goToStock(item.symbol)}
                        >
                          <div className="portfolio-holding-item__main">
                            <StockLabel symbol={item.symbol} starred={automatedSymbols.has(item.symbol.toUpperCase())} />
                            <Typography size={14} className="portfolio-holding-item__value">
                              {formatUsd(item.marketValue)}
                            </Typography>
                          </div>
                          <div className="portfolio-holding-item__meta">
                            <Typography size={12} className="portfolio-holding-item__qty">
                              {item.quantity.toLocaleString('en-US', {
                                maximumFractionDigits: 4,
                              })}
                              주
                            </Typography>
                            <Typography
                              size={12}
                              className={`portfolio-holding-item__pl ${getKrProfitLossClass(item.profitLoss) ?? ''}`}
                            >
                              {formatProfitLoss(item.profitLoss, item.profitLossRate)}
                            </Typography>
                          </div>
                        </button>
                        {onToggleHidden && (
                          <button
                            type="button"
                            className="portfolio-holding-hide"
                            title="자산에 다시 표시"
                            aria-label={`${item.symbol} 자산에 다시 표시`}
                            onClick={() => onToggleHidden(item.symbol)}
                          >
                            표시
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      </section>

      <OpenOrdersPanel
        openOrders={openOrders}
        onCancel={onCancelOrder}
        holdingsAvgPrices={Object.fromEntries(
          [...holdings, ...hiddenHoldings]
            .filter((h) => typeof h.averagePrice === 'number' && h.averagePrice > 0)
            .map((h) => [h.symbol.toUpperCase(), h.averagePrice as number])
        )}
      />
    </aside>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../shared/api/client';
import { unwrapResult } from '../shared/lib/parse';
import { Button } from '../shared/ui/Button';
import { Chip } from '../shared/ui/Chip';
import { Typography } from '../shared/ui/Typography';

interface Briefing {
  at: number;
  symbols: string[];
  overall: string;
  items: {
    symbol: string;
    summary: string;
    news: { title: string; date?: string; impact?: 'positive' | 'negative' | 'neutral'; note?: string }[];
  }[];
  model: string;
  fallback?: boolean;
  cached?: boolean;
}

const IMPACT_LABELS: Record<string, string> = {
  positive: '호재',
  negative: '악재',
  neutral: '중립',
};

interface SymbolAnalysis {
  at: number;
  symbol: string;
  stance: 'bullish' | 'bearish' | 'neutral';
  trend: string;
  drivers: string[];
  support?: string;
  resistance?: string;
  scenario: string;
  risks: string;
  fallback?: boolean;
}

const STANCE_LABELS: Record<string, string> = {
  bullish: '상승 우위',
  bearish: '하락 우위',
  neutral: '중립',
};

function formatAt(at: number): string {
  return new Date(at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * 보유 종목 AI 브리핑 모달 — 서버가 웹 검색으로 종합한 뉴스·공시·현황을 표시.
 * 열면 서버 캐시(60분)를 바로 보여주고, '갱신'은 강제로 새로 생성한다(웹 검색 포함 1~2분).
 */
export function MarketBriefingModal({
  symbols,
  onClose,
}: {
  symbols: string[];
  onClose: () => void;
}) {
  const [data, setData] = useState<Briefing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 종목별 보기 — 판단 로그 패널과 동일한 필터 칩(전체/종목).
  const [filter, setFilter] = useState<string>('ALL');
  // 종목별 시황 분석 — 카드에서 요청 시 로드(서버 30분 캐시).
  const [analyses, setAnalyses] = useState<Record<string, SymbolAnalysis | null>>({});
  const [analysisLoading, setAnalysisLoading] = useState<string | null>(null);

  const loadAnalysis = useCallback(async (symbol: string, force: boolean) => {
    setAnalysisLoading(symbol);
    try {
      const res = unwrapResult(await api.getAiSymbolAnalysis(symbol, force));
      if (res) setAnalyses((prev) => ({ ...prev, [symbol]: res }));
    } catch {
      setAnalyses((prev) => ({ ...prev, [symbol]: null }));
    } finally {
      setAnalysisLoading((cur) => (cur === symbol ? null : cur));
    }
  }, []);

  // 부모가 매 렌더마다 새 배열을 넘겨도(보유 폴링) 재요청되지 않게 키 문자열로 안정화.
  const symbolsKey = symbols.map((s) => s.toUpperCase()).join(',');
  const load = useCallback(
    async (force: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const res = unwrapResult(await api.getAiBriefing(symbolsKey.split(','), force));
        if (res) setData(res);
      } catch (e) {
        setError(e instanceof Error ? e.message : '브리핑을 불러오지 못했습니다.');
      } finally {
        setLoading(false);
      }
    },
    [symbolsKey]
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return createPortal(
    <div className="backtest-modal__overlay" onClick={onClose} role="presentation">
      <div
        className="backtest-modal market-briefing-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="보유 종목 AI 브리핑"
      >
        <div className="backtest-modal__head">
          <Typography size={16} as="h2" className="backtest-modal__title">
            AI 브리핑
            {data && !data.fallback && (
              <span className="hint"> · {formatAt(data.at)} 생성{data.cached ? ' (캐시)' : ''}</span>
            )}
          </Typography>
          <button type="button" className="backtest-modal__close" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>
        <div className="backtest-modal__body">
          <div className="market-briefing__toolbar">
            <Typography size={12} className="hint">
              보유 {symbols.length}종목 · 뉴스/공시 웹 검색 종합 (투자 권유 아님)
            </Typography>
            <Button size="sm" disabled={loading} onClick={() => void load(true)}>
              {loading ? '생성 중…' : '갱신'}
            </Button>
          </div>

          {loading && (
            <Typography size={14} as="p" className="hint">
              브리핑 생성 중 — 웹 검색을 포함해 1~2분 걸릴 수 있어요.
            </Typography>
          )}
          {error && <div className="banner error">{error}</div>}
          {data?.fallback && !loading && (
            <div className="banner error">{data.overall}</div>
          )}

          {data && !data.fallback && (
            <>
              {/* 종합 요약 — 전체 보기에서만. 종목 칩 선택 시 해당 카드에 집중 */}
              {filter === 'ALL' && data.overall && (
                <Typography size={16} as="p" className="market-briefing__overall">
                  {data.overall}
                </Typography>
              )}
              {data.items.length > 1 && (
                <div className="market-briefing__filter" role="tablist" aria-label="브리핑 종목 필터">
                  <Chip selected={filter === 'ALL'} onClick={() => setFilter('ALL')}>
                    전체
                  </Chip>
                  {data.items.map((item) => (
                    <Chip
                      key={item.symbol}
                      selected={filter === item.symbol}
                      onClick={() => setFilter(item.symbol)}
                    >
                      {item.symbol}
                    </Chip>
                  ))}
                </div>
              )}
              <ul className="market-briefing__list">
                {data.items
                  .filter((item) => filter === 'ALL' || item.symbol === filter)
                  .map((item) => (
                  <li key={item.symbol} className="market-briefing__item">
                    <Typography size={18} as="h3" className="market-briefing__symbol">
                      {item.symbol}
                    </Typography>
                    {item.summary && (
                      <Typography size={16} as="p" className="market-briefing__summary">
                        {item.summary}
                      </Typography>
                    )}
                    {item.news.length > 0 && (
                      <ul className="market-briefing__news">
                        {item.news.map((n, i) => (
                          <li key={i} className="market-briefing__news-item">
                            <Typography size={16} className="market-briefing__news-title">
                              {n.impact && (
                                <span className={`market-briefing__impact is-${n.impact}`}>
                                  {IMPACT_LABELS[n.impact]}
                                </span>
                              )}
                              {n.title}
                              {n.date && <span className="hint"> · {n.date}</span>}
                            </Typography>
                            {n.note && (
                              <Typography size={14} as="p" className="hint market-briefing__news-note">
                                {n.note}
                              </Typography>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}

                    {/* 종목별 시황 분석 — 캔들·지표 + 웹 검색 심층 리포트(요청 시 로드) */}
                    <div className="market-briefing__analysis-actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={analysisLoading === item.symbol}
                        onClick={() => void loadAnalysis(item.symbol, Boolean(analyses[item.symbol]))}
                      >
                        {analysisLoading === item.symbol
                          ? '분석 중…'
                          : analyses[item.symbol]
                            ? '다시 분석'
                            : '시황 분석'}
                      </Button>
                    </div>
                    {analysisLoading === item.symbol && (
                      <Typography size={14} as="p" className="hint">
                        시황 분석 중 — 웹 검색을 포함해 1~2분 걸릴 수 있어요.
                      </Typography>
                    )}
                    {analyses[item.symbol]?.fallback && analysisLoading !== item.symbol && (
                      <div className="banner error">{analyses[item.symbol]!.trend}</div>
                    )}
                    {analyses[item.symbol] && !analyses[item.symbol]!.fallback && (
                      <div className="market-briefing__analysis">
                        <Typography size={14} className={`market-briefing__stance is-${analyses[item.symbol]!.stance}`}>
                          {STANCE_LABELS[analyses[item.symbol]!.stance]}
                        </Typography>
                        <Typography size={16} as="p" className="market-briefing__analysis-text">
                          {analyses[item.symbol]!.trend}
                        </Typography>
                        {analyses[item.symbol]!.drivers.length > 0 && (
                          <ul className="market-briefing__drivers">
                            {analyses[item.symbol]!.drivers.map((d, i) => (
                              <li key={i}>
                                <Typography size={16}>{d}</Typography>
                              </li>
                            ))}
                          </ul>
                        )}
                        {(analyses[item.symbol]!.support || analyses[item.symbol]!.resistance) && (
                          <Typography size={16} as="p" className="market-briefing__analysis-text">
                            {analyses[item.symbol]!.support ? `지지: ${analyses[item.symbol]!.support}` : ''}
                            {analyses[item.symbol]!.support && analyses[item.symbol]!.resistance ? ' · ' : ''}
                            {analyses[item.symbol]!.resistance ? `저항: ${analyses[item.symbol]!.resistance}` : ''}
                          </Typography>
                        )}
                        {analyses[item.symbol]!.scenario && (
                          <Typography size={16} as="p" className="market-briefing__analysis-text">
                            시나리오 — {analyses[item.symbol]!.scenario}
                          </Typography>
                        )}
                        {analyses[item.symbol]!.risks && (
                          <Typography size={14} as="p" className="hint market-briefing__analysis-text">
                            리스크 — {analyses[item.symbol]!.risks}
                          </Typography>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

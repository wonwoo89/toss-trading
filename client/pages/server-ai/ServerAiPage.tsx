import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  api,
  type AutoEngineStatus,
  type AutoLogEntry,
  type AutoSymbolConfig,
  type AutoTradeConfig,
  type AutoTradeLimits,
  type BgLiveSummary,
  type LiveLogEntry,
  type LiveTraderStatus,
  type PaperSummary,
} from '../../shared/api/client';
import { Button } from '../../shared/ui/Button';
import { Chip } from '../../shared/ui/Chip';
import { Switch } from '../../shared/ui/Switch';
import { TextField } from '../../shared/ui/TextField';
import { Typography } from '../../shared/ui/Typography';
import { NumberField } from '../../widgets/NumberField';
import { ServerAiSidebar } from '../../widgets/ServerAiSidebar';
import { useToast } from '../../app/providers/ToastContext';
import { runSymbolBacktestFull } from '../../shared/lib/runSymbolBacktest';
import type { CandleInterval } from '../../shared/types';

/** 상태·로그 폴링 주기 — 엔진 틱이 5분 간격이라 촘촘할 필요 없다. */
const POLL_MS = 15_000;

const SESSION_LABELS: Record<string, string> = {
  day: '데이마켓',
  pre: '프리마켓',
  regular: '정규장',
  after: '애프터마켓',
  closed: '장 마감',
  holiday: '휴장',
  unknown: '알 수 없음',
};

const ACTION_LABELS: Record<string, string> = { BUY: '매수', SELL: '매도', HOLD: '보류' };

function formatTime(epochMs: number | null): string {
  if (!epochMs) return '—';
  return new Date(epochMs).toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function unwrap<T>(res: { result: T }): T {
  return res.result;
}

const EMPTY_CONFIG: AutoTradeConfig = { enabled: false, dailyLossLimitUsd: 0, atrLevels: false, symbols: [] };

/** 판단 사유가 이 길이를 넘으면 기본 축약(1줄) + '상세' 토글을 보여준다. */
const REASON_CLAMP_LEN = 60;

/** 판단 로그 목록 — 로그 카드(전체/필터)와 종목별 모달이 공유하는 렌더러.
 *  긴 사유는 기본 1줄로 축약하고 로그별 '상세' 토글로 전체 내용을 펼쳐 본다. */
function LogList({ entries, emptyText }: { entries: AutoLogEntry[]; emptyText: string }) {
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const toggle = (id: number) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (entries.length === 0) {
    return (
      <Typography size={14} as="p" className="hint">
        {emptyText}
      </Typography>
    );
  }
  return (
    <ul className="server-ai-logs">
      {entries.map((log) => {
        const isLong = log.reason.length > REASON_CLAMP_LEN;
        const isOpen = expandedIds.has(log.id);
        return (
          <li key={log.id} className={`server-ai-log server-ai-log--${log.action.toLowerCase()}`}>
            <div className="server-ai-log__meta">
              <span className="server-ai-log__time">{formatTime(log.t)}</span>
              <span className="server-ai-log__symbol">{log.symbol}</span>
              <span className={`server-ai-log__action is-${log.action.toLowerCase()}`}>
                {ACTION_LABELS[log.action] ?? log.action}
              </span>
              {!log.fallback && (
                <span className="server-ai-log__confidence">
                  {Math.round(log.confidence * 100)}%
                </span>
              )}
              {log.currentPrice > 0 && (
                <span className="server-ai-log__price">${log.currentPrice}</span>
              )}
              <span className="hint">{SESSION_LABELS[log.session] ?? log.session}</span>
              {isLong && (
                <button
                  type="button"
                  className="server-ai-log__more"
                  onClick={() => toggle(log.id)}
                  aria-expanded={isOpen}
                >
                  {isOpen ? '접기' : '상세'}
                </button>
              )}
            </div>
            <Typography
              size={14}
              as="p"
              className={`server-ai-log__reason${isLong && !isOpen ? ' is-clamped' : ''}`}
            >
              {log.reason}
            </Typography>
            {log.paper?.fill && (
              <Typography size={12} as="p" className="server-ai-log__paper">
                가상 체결: {log.paper.fill.side === 'BUY' ? '매수' : '매도'}{' '}
                {log.paper.fill.quantity}주 @ ${log.paper.fill.price} — 가상 수익률{' '}
                {log.paper.returnPct > 0 ? '+' : ''}
                {log.paper.returnPct.toFixed(2)}%
              </Typography>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** 라이브 트레이더 로그 레벨 라벨 — 서버 LiveLogEntry.level 대응. */
const LIVE_LEVEL_LABELS: Record<LiveLogEntry['level'], string> = {
  trigger: '트리거',
  exec: '체결',
  skip: '보류',
  block: '차단',
  error: '오류',
  ai: 'AI',
};

/** 단일 종목 집중 AI 매매(서버 실주문) 현황 — 5초 폴링으로 기기 간 동일 상태를 보여준다. */
/** 라이브 로그 축약 기준 — 이 길이를 넘으면 1줄 말줄임 + '상세' 토글. */
const LIVE_TEXT_CLAMP_LEN = 42;

function LiveTraderSection({
  openLogRequest = false,
  onOpenLogConsumed,
  onNavigateToSymbol,
}: {
  openLogRequest?: boolean;
  onOpenLogConsumed?: () => void;
  /** 티커 클릭 시 차트 이동 — 임베드(모바일)에서는 탭 전환까지 필요해 부모가 주입한다. */
  onNavigateToSymbol?: (symbol: string) => void;
} = {}) {
  const [live, setLive] = useState<LiveTraderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  // '전체보기' — 좁은 로그 영역 대신 큰 모달에서 전체 로그를 상세(전문)로 본다.
  const [showAllLogs, setShowAllLogs] = useState(false);

  // 임베드(모바일 AI 탭)에서의 열기 요청 — 소비 즉시 부모 상태를 리셋해 재오픈을 막는다.
  useEffect(() => {
    if (openLogRequest) {
      setShowAllLogs(true);
      onOpenLogConsumed?.();
    }
  }, [openLogRequest, onOpenLogConsumed]);

  // 투자 화면의 '로그 보기 →' 진입: 도착 즉시 전체 로그 모달을 연다(상태는 1회성 소비).
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if ((location.state as { openLiveLog?: boolean } | null)?.openLiveLog) {
      setShowAllLogs(true);
      navigate(location.pathname, { replace: true, state: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!showAllLogs) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowAllLogs(false);
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [showAllLogs]);
  const toggleLog = (id: number) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const st = unwrap(await api.getLiveTraderStatus());
        if (!cancelled) {
          setLive(st);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '상태 조회 실패');
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const cfg = live?.config;
  const enabled = cfg?.enabled === true && Boolean(cfg?.symbol);
  const pos = live?.position ?? null;

  // 켜기/끄기 — 켜기는 실제 주문이 나가므로 명시적 확인. 종목은 마지막 실행 종목을 사용
  // (종목 변경/신규 시작은 투자 화면의 자동매매 패널에서).
  const { showToast } = useToast();
  const [toggling, setToggling] = useState(false);
  const toggleEnabled = async (next: boolean) => {
    if (!live || toggling) return;
    if (next && !live.config.symbol) {
      showToast('켤 종목이 없습니다 — 투자 화면에서 AI 매매를 시작해 주세요.', 'error');
      return;
    }
    if (
      next &&
      !window.confirm(
        `${live.config.symbol} 단일 종목 AI 매매를 켭니다.\n서버가 확인 없이 실제 매수/매도 주문을 냅니다. 계속할까요?`
      )
    ) {
      return;
    }
    setToggling(true);
    try {
      const res = unwrap(await api.saveLiveTraderConfig({ ...live.config, enabled: next }));
      setLive((cur) => (cur ? { ...cur, config: res.config } : cur));
      showToast(
        next ? `단일 종목 AI 매매 시작 — ${res.config.symbol}` : '단일 종목 AI 매매를 껐습니다.',
        'success'
      );
    } catch (e) {
      showToast(e instanceof Error ? e.message : '설정 저장 실패', 'error');
    } finally {
      setToggling(false);
    }
  };

  return (
    <section className="panel server-ai-card" aria-label="단일 종목 AI 매매">
      <div className="server-ai-card__head">
        <Typography size={16} as="h2">
          단일 종목 집중 AI 매매 <span className="hint">(실주문)</span>
        </Typography>
        <div className="server-ai-kill">
          <Typography size={14} className={enabled ? 'server-ai-kill__on' : 'hint'}>
            {enabled ? `실행 중 · ${cfg?.symbol}` : cfg?.symbol ? `꺼짐 · ${cfg.symbol}` : '꺼짐'}
          </Typography>
          <Switch
            checked={enabled}
            onChange={(checked) => void toggleEnabled(checked)}
            disabled={toggling || !live || (!enabled && !cfg?.symbol)}
            aria-label="단일 종목 AI 매매 켜기/끄기"
          />
        </div>
      </div>

      {error && (
        <Typography size={12} as="p" className="server-ai-error">
          {error}
        </Typography>
      )}

      {!enabled ? (
        <Typography size={14} as="p" className="hint">
          실행 중인 단일 종목 AI 매매가 없습니다. 투자 화면의 자동매매 패널에서{' '}
          <strong>AI 매매</strong> 모드를 켜면 서버가 그 종목을 집중 감시하며 실제 주문을 냅니다.
        </Typography>
      ) : (
        <>
          <dl className="server-ai-status">
            <div>
              <dt>종목</dt>
              <dd>
                {cfg?.symbol ? (
                  <button
                    type="button"
                    className="server-ai-symbol-link"
                    onClick={() =>
                      onNavigateToSymbol
                        ? onNavigateToSymbol(cfg.symbol)
                        : navigate(`/stock/${cfg.symbol}`)
                    }
                    title={`${cfg.symbol} 차트 보기`}
                  >
                    {cfg.symbol}
                  </button>
                ) : (
                  '—'
                )}
              </dd>
            </div>
            <div>
              <dt>미국장 세션</dt>
              <dd>{live?.session ? (SESSION_LABELS[live.session] ?? live.session) : '—'}</dd>
            </div>
            <div>
              <dt>다음 판단</dt>
              <dd>
                {formatTime(live?.nextTickAt ?? null)}
                {live?.ticking ? ' · 판단 중…' : ''}
              </dd>
            </div>
            <div>
              <dt>오늘 실현손익</dt>
              <dd className={live && live.todayRealizedUsd !== 0 ? (live.todayRealizedUsd > 0 ? 'up' : 'down') : undefined}>
                {live ? `${live.todayRealizedUsd >= 0 ? '+' : '−'}$${Math.abs(live.todayRealizedUsd).toFixed(2)}` : '—'}
              </dd>
            </div>
            <div>
              <dt>매매 성과</dt>
              <dd>
                {live?.stats && live.stats.sells > 0
                  ? `매도 ${live.stats.sells}회 · 승 ${live.stats.wins}/패 ${live.stats.losses} (승률 ${((live.stats.wins / live.stats.sells) * 100).toFixed(0)}%)`
                  : '아직 없음'}
              </dd>
            </div>
            <div>
              <dt>보유</dt>
              <dd>
                {pos ? `${pos.quantity}주 @ $${pos.averagePrice.toFixed(2)}` : '없음'}
              </dd>
            </div>
            <div>
              {/* 수익률은 토스 보유 API 의 비용(수수료·세금) 반영값(rateAfterCost) — 보유 종목 카드와 동일 기준 */}
              <dt>평가(실수익)</dt>
              <dd className={pos?.profitLossPct !== undefined ? (pos.profitLossPct >= 0 ? 'up' : 'down') : undefined}>
                {pos?.currentPrice !== undefined
                  ? `$${pos.currentPrice.toFixed(2)}${
                      pos.profitLossPct !== undefined
                        ? ` (${pos.profitLossPct >= 0 ? '+' : ''}${pos.profitLossPct.toFixed(2)}%)`
                        : ''
                    }`
                  : '—'}
              </dd>
            </div>
          </dl>

          <Typography size={12} as="p" className="hint server-ai-live-config">
            목표 +{cfg?.targetPercent}% · 손절 -{cfg?.stopLossPercent}%
            {cfg && cfg.trailingStopPercent > 0 ? ` · 트레일링 ${cfg.trailingStopPercent}%` : ''}
            {cfg && cfg.dailyLossLimitUsd > 0 ? ` · 일손실 한도 $${cfg.dailyLossLimitUsd}` : ''}
            {cfg?.holdTpOnTrend ? ' · 추세 홀드 ON' : ''}
          </Typography>

          {live?.lastError && (
            <Typography size={12} as="p" className="server-ai-error">
              최근 오류: {live.lastError}
            </Typography>
          )}
        </>
      )}

      {/* 로그는 꺼진 뒤에도 마지막 세션 기록을 볼 수 있게 항상 표시.
          긴 내용은 기본 1줄 말줄임 — 로그별 '상세' 토글, '전체보기'로 큰 모달 열람. */}
      {(live?.logs.length ?? 0) > 0 && (
        <div className="server-ai-live-logs__head">
          <Typography size={12} className="hint">라이브 로그 (최근 {Math.min(live!.logs.length, 30)}건)</Typography>
          <Button size="sm" variant="ghost" onClick={() => setShowAllLogs(true)}>
            전체보기
          </Button>
        </div>
      )}
      {(live?.logs.length ?? 0) > 0 && (
        <ul className="server-ai-live-logs">
          {live!.logs.slice(0, 30).map((log) => {
            const isLong = log.text.length > LIVE_TEXT_CLAMP_LEN;
            const isOpen = expandedIds.has(log.id);
            return (
              <li key={log.id} className={`server-ai-live-log is-${log.level}`}>
                <span className="server-ai-log__time">{formatTime(log.t)}</span>
                <span className={`server-ai-live-log__level is-${log.level}`}>
                  {LIVE_LEVEL_LABELS[log.level] ?? log.level}
                </span>
                <Typography
                  size={12}
                  as="span"
                  className={`server-ai-live-log__text${isLong && !isOpen ? ' is-clamped' : ''}`}
                >
                  {log.text}
                </Typography>
                {isLong && (
                  <button
                    type="button"
                    className="server-ai-log__more"
                    onClick={() => toggleLog(log.id)}
                    aria-expanded={isOpen}
                  >
                    {isOpen ? '접기' : '상세'}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* 전체보기 모달 — 전체 로그를 축약 없이(전문) 넓은 모달에서 열람.
          카드(.panel)의 backdrop-filter 가 fixed 기준을 가두므로 body 포털로 띄운다. */}
      {showAllLogs && live && createPortal(
        <div
          className="backtest-modal__overlay"
          onClick={() => setShowAllLogs(false)}
          role="presentation"
        >
          <div
            className="backtest-modal server-ai-fulllog-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="단일 종목 판단 로그 전체"
          >
            <div className="backtest-modal__head">
              <Typography size={16} as="h2" className="backtest-modal__title">
                단일 종목 판단 로그{cfg?.symbol ? ` · ${cfg.symbol}` : ''}{' '}
                <span className="hint">(전체 {live.logs.length}건)</span>
              </Typography>
              <button
                type="button"
                className="backtest-modal__close"
                onClick={() => setShowAllLogs(false)}
                aria-label="닫기"
              >
                ✕
              </button>
            </div>
            <div className="backtest-modal__body server-ai-log-modal__body">
              <ul className="server-ai-live-logs server-ai-live-logs--full">
                {live.logs.map((log) => (
                  <li key={log.id} className={`server-ai-live-log is-${log.level}`}>
                    <span className="server-ai-log__time">{formatTime(log.t)}</span>
                    <span className={`server-ai-live-log__level is-${log.level}`}>
                      {LIVE_LEVEL_LABELS[log.level] ?? log.level}
                    </span>
                    <Typography size={12} as="span" className="server-ai-live-log__text">
                      {log.text}
                    </Typography>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>,
        document.body
      )}
    </section>
  );
}

/** 종목별 판단 로그 미니 라인차트 — 판단 시점 가격(currentPrice)의 흐름 + 평단가 점선(보유 시).
 *  실시간 시세가 아니라 판단 로그가 갱신되는 시점(폴링)에만 다시 그려진다. */
function LogSparkline({ entries, avgPrice }: { entries: AutoLogEntry[]; avgPrice?: number }) {
  const points = useMemo(
    () =>
      entries
        .filter((l) => l.currentPrice > 0)
        .map((l) => ({ t: l.t, p: l.currentPrice }))
        .sort((a, b) => a.t - b.t),
    [entries]
  );
  if (points.length < 2) return null;

  const W = 600;
  const H = 110;
  const PAD_X = 4;
  const PAD_Y = 10;
  const avg = avgPrice !== undefined && avgPrice > 0 ? avgPrice : undefined;
  let min = Math.min(...points.map((pt) => pt.p));
  let max = Math.max(...points.map((pt) => pt.p));
  if (avg !== undefined) {
    min = Math.min(min, avg);
    max = Math.max(max, avg);
  }
  if (max - min < 1e-9) {
    max += max * 0.001 + 0.01;
    min -= min * 0.001 + 0.01;
  }
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const span = Math.max(1, t1 - t0);
  const x = (t: number) => PAD_X + ((t - t0) / span) * (W - PAD_X * 2);
  const y = (p: number) => PAD_Y + (1 - (p - min) / (max - min)) * (H - PAD_Y * 2);
  const path = points
    .map((pt, i) => `${i === 0 ? 'M' : 'L'}${x(pt.t).toFixed(1)} ${y(pt.p).toFixed(1)}`)
    .join(' ');
  const last = points[points.length - 1];
  const ref = avg ?? points[0].p;
  const lineColor = last.p >= ref ? 'var(--color-up)' : 'var(--color-down)';

  return (
    <div className="server-ai-sparkline" aria-label="판단 시점 가격 흐름 차트">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-hidden="true">
        {avg !== undefined && (
          <line
            x1={PAD_X}
            x2={W - PAD_X}
            y1={y(avg)}
            y2={y(avg)}
            className="server-ai-sparkline__avg"
          />
        )}
        <path d={path} className="server-ai-sparkline__line" style={{ stroke: lineColor }} />
        <circle cx={x(last.t)} cy={y(last.p)} r={2.5} fill={lineColor} />
      </svg>
      <div className="server-ai-sparkline__meta">
        <Typography size={10} className="server-ai-sparkline__label">
          {formatTime(t0)} ~ {formatTime(t1)} · 판단 {points.length}회
        </Typography>
        <Typography size={10} className="server-ai-sparkline__label">
          {avg !== undefined ? `평단 $${avg.toFixed(2)} · ` : ''}최근 ${last.p.toFixed(2)}
        </Typography>
      </div>
    </div>
  );
}

/**
 * AI 매매 페이지 — 단일 종목 집중(서버 실주문) 현황 + 백그라운드(다종목 페이퍼) 엔진의
 * 관리·모니터링을 한 화면에서 보여준다.
 * embedded=true 면 모바일 하단 탭('AI 매매') 안에 임베드 — 제목/뒤로가기 헤더를 생략한다.
 */
export function ServerAiPage({
  embedded = false,
  openLiveLog = false,
  onLiveLogConsumed,
  onNavigateToSymbol,
}: {
  embedded?: boolean;
  /** 임베드(모바일 AI 탭)에서 단일종목 전체 로그 모달을 열라는 1회성 요청. */
  openLiveLog?: boolean;
  onLiveLogConsumed?: () => void;
  /** 티커 클릭 시 차트 이동 핸들러 — 임베드(모바일 AI 탭)는 같은 라우트 안이라
      navigate 만으로는 화면이 안 바뀌므로 부모(StockPage)가 탭 전환까지 처리한다. */
  onNavigateToSymbol?: (symbol: string) => void;
} = {}) {
  const { showToast } = useToast();

  // 서버에 저장된 설정(=마지막 저장본)과 편집 중 초안을 분리 — 킬스위치는 저장본 기준 즉시 반영.
  const [savedConfig, setSavedConfig] = useState<AutoTradeConfig>(EMPTY_CONFIG);
  const [draft, setDraft] = useState<AutoTradeConfig>(EMPTY_CONFIG);
  const [limits, setLimits] = useState<AutoTradeLimits>({
    maxSymbols: 5,
    maxBuyPercent: 5,
    candleInterval: '5m',
  });
  const [status, setStatus] = useState<AutoEngineStatus | null>(null);
  const [logs, setLogs] = useState<AutoLogEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [newSymbol, setNewSymbol] = useState('');

  // 판단 로그 종목 보기 — 데스크톱은 필터 칩, 모바일은 종목 카드의 '로그' 버튼 → 모달.
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= 640
  );
  useEffect(() => {
    const update = () => setIsMobile(window.innerWidth <= 640);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  const [logFilter, setLogFilter] = useState<string>('ALL');
  // 모바일 판단 로그 모달 — 데스크톱 로그 패널 전체(필터 칩 포함)를 모달로 띄운다.
  const [logModalOpen, setLogModalOpen] = useState(false);

  // 모달 열림 중 Esc 닫기 + 배경 스크롤 잠금.
  useEffect(() => {
    if (!logModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLogModalOpen(false);
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [logModalOpen]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(savedConfig),
    [draft, savedConfig]
  );

  const refresh = useCallback(async () => {
    try {
      const [statusRes, logsRes] = await Promise.all([api.getAutoStatus(), api.getAutoLogs(100)]);
      setStatus(unwrap(statusRes));
      setLogs(unwrap(logsRes));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '상태 조회 실패');
    }
  }, []);

  const [resetting, setResetting] = useState(false);
  const resetEngine = useCallback(async () => {
    if (
      typeof window !== 'undefined' &&
      !window.confirm(
        '엔진을 초기화합니다.\n판단 로그를 비우고, 페이퍼는 $1,000 로 리셋합니다.\n실거래 풀은 실계좌 보유로 재동기화됩니다(실제 보유는 그대로 관리, 손익 기록은 새로 시작).\n계속할까요?'
      )
    ) {
      return;
    }
    setResetting(true);
    try {
      const r = unwrap(await api.resetAutoEngine());
      await refresh();
      const failNote = r.liveFailed.length ? ` · 실거래 조회 실패: ${r.liveFailed.join(', ')}` : '';
      showToast(`초기화 완료 — 페이퍼 ${r.paper}종목 · 실거래 ${r.live}종목 재동기화${failNote}`, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '초기화 실패', 'error');
    } finally {
      setResetting(false);
    }
  }, [refresh, showToast]);

  // 최초 로드: 설정 + 상태 + 로그.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getAutoConfig();
        if (cancelled) return;
        const { config, limits: serverLimits } = unwrap(res);
        setSavedConfig(config);
        setDraft(config);
        setLimits(serverLimits);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : '설정 조회 실패');
      }
    })();
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refresh]);

  const savingRef = useRef(false);
  const persist = useCallback(
    async (next: AutoTradeConfig, successMessage: string) => {
      if (savingRef.current) return;
      savingRef.current = true;
      setSaving(true);
      try {
        const res = await api.saveAutoConfig(next);
        const normalized = unwrap(res).config;
        setSavedConfig(normalized);
        setDraft(normalized);
        showToast(successMessage, 'success');
        void refresh();
      } catch (err) {
        showToast(err instanceof Error ? err.message : '저장에 실패했습니다.', 'error');
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [refresh, showToast]
  );

  // 킬스위치 — 안전 컨트롤이라 '저장' 없이 즉시 반영. 편집 중 초안은 건드리지 않고
  // 마지막 저장본에 enabled 만 바꿔 저장한다(미저장 편집이 몰래 저장되는 걸 방지).
  const toggleEnabled = (nextEnabled: boolean) => {
    void persist(
      { ...savedConfig, enabled: nextEnabled },
      nextEnabled ? '백그라운드 AI 매매를 켰습니다.' : '백그라운드 AI 매매를 껐습니다(전 종목 정지).'
    );
  };

  const updateSymbol = (index: number, patch: Partial<AutoSymbolConfig>) => {
    setDraft((current) => ({
      ...current,
      symbols: current.symbols.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    }));
  };

  const removeSymbol = (index: number) => {
    setDraft((current) => ({
      ...current,
      symbols: current.symbols.filter((_, i) => i !== index),
    }));
  };

  // AI 백테스트 추천 — 종목별 진행 상태(버튼 로딩)와 중복 실행 가드.
  const [recommending, setRecommending] = useState<Set<string>>(new Set());
  const recommendingRef = useRef<Set<string>>(new Set());

  /** 최근 캔들로 백테스트 그리드 + AI 종합 추천을 계산해 해당 종목의 목표/손절 초안에 적용.
   *  백테스트 페이지의 'AI 추천 → 적용'과 같은 산식(그리드 24조합 + AI bestIndex, 실패 시 누적 1위). */
  const applyAiRecommendation = useCallback(
    async (symbol: string) => {
      if (recommendingRef.current.has(symbol)) return;
      recommendingRef.current.add(symbol);
      setRecommending(new Set(recommendingRef.current));
      try {
        const interval = limits.candleInterval as CandleInterval;
        const base = { forwardBars: 15, costPct: 0.2 };
        const outcome = await runSymbolBacktestFull(symbol, interval, {
          ...base,
          targetPct: 1,
          stopPct: 3,
        });
        const scenarios = outcome.scenarios ?? [];
        if (scenarios.length === 0) throw new Error('최적화 결과가 없습니다.');
        // AI 종합 추천(bestIndex) — 실패 시 누적 수익 1위(0) 폴백.
        let bestIndex = 0;
        try {
          const res = await api.analyzeBacktestScenarios({
            symbol,
            interval,
            forwardBars: base.forwardBars,
            costPct: base.costPct,
            usedCandles: outcome.usedCandles,
            scenarios: scenarios.map((s) => ({
              targetPct: s.targetPct,
              stopPct: s.stopPct,
              trades: s.trades,
              winRatePct: s.winRatePct,
              avgReturnPct: s.avgReturnPct,
              totalReturnPct: s.totalReturnPct,
              maxDrawdownPct: s.maxDrawdownPct,
            })),
          });
          bestIndex = Math.min(Math.max(0, res.result.bestIndex), scenarios.length - 1);
        } catch {
          // AI 종합 추천 실패 — 누적 1위 시나리오 사용.
        }
        const best = scenarios[bestIndex];
        setDraft((current) => ({
          ...current,
          symbols: current.symbols.map((s) =>
            s.symbol === symbol
              ? { ...s, targetPercent: best.targetPct, stopLossPercent: best.stopPct }
              : s
          ),
        }));
        showToast(
          `${symbol} AI 추천 적용: 목표 +${best.targetPct}% / 손절 -${best.stopPct}% — '저장'을 누르면 반영됩니다.`,
          'success'
        );
      } catch (err) {
        showToast(
          `${symbol} AI 추천 실패: ${err instanceof Error ? err.message : '백테스트 오류'}`,
          'error'
        );
      } finally {
        recommendingRef.current.delete(symbol);
        setRecommending(new Set(recommendingRef.current));
      }
    },
    [limits.candleInterval, showToast]
  );

  const addSymbol = () => {
    const symbol = newSymbol.trim().toUpperCase();
    if (!symbol) return;
    if (draft.symbols.some((s) => s.symbol === symbol)) {
      showToast('이미 등록된 종목입니다.', 'error');
      return;
    }
    if (draft.symbols.length >= limits.maxSymbols) {
      showToast(`종목은 최대 ${limits.maxSymbols}개까지 등록할 수 있습니다.`, 'error');
      return;
    }
    setDraft((current) => ({
      ...current,
      symbols: [
        ...current.symbols,
        {
          symbol,
          active: true,
          live: false,
          poolUsd: 500,
          targetPercent: 1,
          stopLossPercent: 3,
          trailingStopPercent: 0,
          buyMaxPercent: limits.maxBuyPercent,
        },
      ],
    }));
    setNewSymbol('');
    // 새 종목은 AI 백테스트 추천을 자동 1회 계산해 목표/손절 초안에 적용한다.
    showToast(`${symbol} 추가 — AI 백테스트 추천 계산 중…`, 'success');
    void applyAiRecommendation(symbol);
  };

  const sessionLabel = status?.lastTickSession
    ? SESSION_LABELS[status.lastTickSession] ?? status.lastTickSession
    : '—';

  // 페이퍼(가상 $1,000) 수익률 — 종목별 뱃지 표시용 맵.
  const paperBySymbol = useMemo(() => {
    const map = new Map<string, PaperSummary>();
    for (const p of status?.paper ?? []) map.set(p.symbol, p);
    return map;
  }, [status]);

  // 실거래 풀 장부 — 종목별 표시용 맵.
  const liveBySymbol = useMemo(() => {
    const map = new Map<string, BgLiveSummary>();
    for (const p of status?.livePools ?? []) map.set(p.symbol, p);
    return map;
  }, [status]);

  // 티커 클릭 → 해당 종목 차트로 이동(전량 매도 후에도 차트 재조회 편의).
  const navigateStock = useNavigate();
  const navigateToStock = (symbol: string) =>
    onNavigateToSymbol ? onNavigateToSymbol(symbol) : navigateStock(`/stock/${symbol}`);

  // 종목별 미니 차트의 평단가 — 실거래는 풀 장부, 페이퍼는 가상 장부 기준(보유 시에만).
  const sparkAvgFor = (symbol: string): number | undefined => {
    const cfg = draft.symbols.find((s) => s.symbol === symbol);
    const summary = cfg?.live ? liveBySymbol.get(symbol) : paperBySymbol.get(symbol);
    return summary && summary.quantity > 0 && summary.averagePrice > 0
      ? summary.averagePrice
      : undefined;
  };

  // 실거래 토글 — 켤 때 명시적 확인(실제 주문이 나간다).
  const toggleLive = (index: number, next: boolean) => {
    const sym = draft.symbols[index];
    if (!sym) return;
    if (next) {
      const ok = window.confirm(
        `${sym.symbol} 백그라운드 실거래를 켭니다.\n배정 풀 $${sym.poolUsd} 안에서 서버가 확인 없이 실제 매수/매도 주문을 냅니다.\n('저장'을 눌러야 서버에 반영됩니다) 계속할까요?`
      );
      if (!ok) return;
    }
    updateSymbol(index, { live: next });
  };

  const content = (
    <main className={`server-ai-page${embedded ? ' server-ai-page--embedded' : ''}`}>
      {/* 타이틀·인트로 문단 제거 — 설명은 백그라운드 카드 제목 옆 '?' 툴팁으로 이동.
          콘텐츠가 포트폴리오 사이드바처럼 헤더 바로 아래에서 시작한다. */}
      {loadError && <div className="banner error">{loadError}</div>}

      {/* 데스크톱 3열 배치: 좌(설정+단일종목) | 중(판단 로그) | 우(포트폴리오 사이드바).
          모바일/임베드는 세로 스택 그대로. */}
      <div className="server-ai-columns">
        <div className="server-ai-columns__main">
      {/* 백그라운드 엔진 상태 + 킬스위치 */}
      <section className="panel server-ai-card" aria-label="백그라운드 엔진 상태">
        <div className="server-ai-card__head">
          <Typography size={16} as="h2">
            백그라운드 AI 매매
            <span className="server-ai-help">
              <button
                type="button"
                className="server-ai-help__trigger"
                aria-label="백그라운드 AI 매매 설명"
              >
                ?
              </button>
              <span className="server-ai-help__tip" role="tooltip">
                브라우저를 꺼도 서버가 <strong>미국장이 열려 있는 동안</strong>
                (데이·프리·정규·애프터) 5분봉 마감마다 등록 종목을 AI로 판단합니다. 페이퍼는
                종목마다 <strong>가상 $1,000</strong>, 실거래는 지정한 풀 안에서 실제
                주문(수수료 반영)해 수익률을 추적합니다.
              </span>
            </span>
          </Typography>
          <div className="server-ai-kill">
            <Typography size={14} className={savedConfig.enabled ? 'server-ai-kill__on' : 'hint'}>
              {savedConfig.enabled ? '실행 중' : '정지됨'}
            </Typography>
            <Switch
              checked={savedConfig.enabled}
              onChange={toggleEnabled}
              disabled={saving}
              aria-label="백그라운드 AI 매매 전체 켜기/끄기 (킬스위치)"
            />
          </div>
        </div>
        <dl className="server-ai-status">
          <div>
            <dt>스케줄러</dt>
            <dd>{status ? (status.running ? '가동' : '중지') : '—'}{status?.ticking ? ' · 판단 중…' : ''}</dd>
          </div>
          <div>
            <dt>AI 인증</dt>
            <dd>{status ? (status.aiConfigured ? '설정됨' : '미설정') : '—'}</dd>
          </div>
          <div>
            <dt>마지막 확인</dt>
            <dd>{formatTime(status?.lastTickAt ?? null)}</dd>
          </div>
          <div>
            <dt>다음 판단</dt>
            <dd>{formatTime(status?.nextTickAt ?? null)}</dd>
          </div>
          <div>
            <dt>미국장 세션</dt>
            <dd>{sessionLabel}</dd>
          </div>
          <div>
            <dt>활성 종목</dt>
            <dd>{status?.activeSymbols.length ? status.activeSymbols.join(', ') : '없음'}</dd>
          </div>
        </dl>
        {status?.lastError && (
          <Typography size={12} as="p" className="server-ai-error">
            최근 오류: {status.lastError}
          </Typography>
        )}
        <div className="server-ai-reset">
          <button
            type="button"
            className="server-ai-reset__btn"
            disabled={resetting}
            onClick={resetEngine}
          >
            ↻ {resetting ? '초기화 중…' : '엔진 초기화'}
          </button>
          <Typography size={12} className="hint">
            판단 로그를 비우고, 페이퍼는 $1,000 로·실거래 풀은 실계좌 보유로 재동기화해 새로
            시작합니다.
          </Typography>
        </div>
      </section>

      {/* 종목·한도 설정 */}
      <section className="panel server-ai-card" aria-label="자동매매 설정">
        <div className="server-ai-card__head">
          <Typography size={16} as="h2">
            종목 설정{' '}
            <span className="hint">
              ({draft.symbols.length}/{limits.maxSymbols} · {limits.candleInterval}봉)
            </span>
          </Typography>
          <Button
            variant="accent"
            size="sm"
            disabled={!dirty || saving}
            onClick={() => void persist(draft, '설정을 저장했습니다.')}
          >
            {saving ? '저장 중…' : dirty ? '저장' : '저장됨'}
          </Button>
        </div>

        <div className="server-ai-add">
          <TextField
            aria-label="추가할 종목 심볼"
            placeholder="심볼 추가 (예: TSLA)"
            value={newSymbol}
            onChange={(e) => setNewSymbol(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addSymbol();
            }}
          />
          <Button size="sm" onClick={addSymbol} disabled={!newSymbol.trim()}>
            추가
          </Button>
        </div>

        {draft.symbols.length === 0 ? (
          <Typography size={14} as="p" className="hint">
            등록된 종목이 없습니다. 심볼을 추가하면 엔진이 판단을 시작합니다.
          </Typography>
        ) : (
          <ul className="server-ai-symbols">
            {draft.symbols.map((s, index) => (
              <li key={s.symbol} className="server-ai-symbol">
                <div className="server-ai-symbol__head">
                  <div className="server-ai-symbol__title">
                    <button
                      type="button"
                      className="server-ai-symbol-link"
                      onClick={() => navigateToStock(s.symbol)}
                      title={`${s.symbol} 차트 보기`}
                    >
                      <Typography size={14} className="server-ai-symbol__name">{s.symbol}</Typography>
                    </button>
                    {s.live && <span className="server-ai-symbol__live-badge">실거래</span>}
                    {(() => {
                      const summary = s.live ? liveBySymbol.get(s.symbol) : paperBySymbol.get(s.symbol);
                      if (!summary) return null;
                      const sign = summary.returnPct > 0 ? '+' : '';
                      const tone =
                        summary.returnPct > 0 ? 'is-up' : summary.returnPct < 0 ? 'is-down' : '';
                      return (
                        <span className={`server-ai-symbol__paper ${tone}`}>
                          {sign}
                          {summary.returnPct.toFixed(2)}%
                        </span>
                      );
                    })()}
                  </div>
                  <div className="server-ai-symbol__controls">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={recommending.has(s.symbol)}
                      onClick={() => void applyAiRecommendation(s.symbol)}
                      title="최근 캔들로 백테스트 최적화를 돌려 AI 추천 목표/손절을 이 종목에 적용"
                    >
                      {recommending.has(s.symbol) ? '추천 중…' : 'AI 추천'}
                    </Button>
                    {isMobile && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setLogFilter(s.symbol);
                          setLogModalOpen(true);
                        }}
                      >
                        로그
                      </Button>
                    )}
                    <Switch
                      checked={s.active}
                      onChange={(checked) => updateSymbol(index, { active: checked })}
                      aria-label={`${s.symbol} 자동매매 활성`}
                    />
                    <Button size="sm" variant="ghost" onClick={() => removeSymbol(index)}>
                      삭제
                    </Button>
                  </div>
                </div>
                {(() => {
                  if (s.live) {
                    const pool = liveBySymbol.get(s.symbol);
                    if (!pool) {
                      return (
                        <Typography size={12} as="p" className="server-ai-symbol__paper-detail hint">
                          실거래 풀 ${s.poolUsd} 대기 — 저장 후 엔진의 첫 판단부터 실제 주문이 나갑니다.
                        </Typography>
                      );
                    }
                    const parts = [
                      `실거래 평가 $${pool.equityUsd.toFixed(2)} / 풀 $${pool.poolUsd}`,
                      `현금 $${pool.cash.toFixed(2)}`,
                      pool.quantity > 0
                        ? `보유 ${pool.quantity}주 @ $${pool.averagePrice.toFixed(2)}`
                        : '보유 없음',
                      `실현 ${pool.realizedUsd >= 0 ? '+' : ''}$${pool.realizedUsd.toFixed(2)}`,
                      ...(pool.openOrderCount > 0 ? [`미체결 ${pool.openOrderCount}건`] : []),
                      ...(pool.stats && pool.stats.sells > 0
                        ? [
                            `매도 ${pool.stats.sells}회 · 승 ${pool.stats.wins}/패 ${pool.stats.losses} (승률 ${Math.round((pool.stats.wins / pool.stats.sells) * 100)}%)`,
                          ]
                        : []),
                    ];
                    return (
                      <Typography size={12} as="p" className="server-ai-symbol__paper-detail">
                        {parts.join(' · ')}
                      </Typography>
                    );
                  }
                  const paper = paperBySymbol.get(s.symbol);
                  if (!paper) {
                    return (
                      <Typography size={12} as="p" className="server-ai-symbol__paper-detail hint">
                        가상 $1,000 대기 — 엔진의 첫 판단(장 열림 중 5분봉) 이후 수익 상황이 표시됩니다.
                      </Typography>
                    );
                  }
                  const parts = [
                    `가상 평가 $${paper.equityUsd.toFixed(2)}`,
                    `현금 $${paper.cash.toFixed(2)}`,
                    paper.quantity > 0
                      ? `보유 ${paper.quantity}주 @ $${paper.averagePrice.toFixed(2)}`
                      : '보유 없음',
                    `실현 ${paper.realizedPnlUsd >= 0 ? '+' : ''}$${paper.realizedPnlUsd.toFixed(2)}`,
                    ...(paper.stats && paper.stats.sells > 0
                      ? [
                          `매도 ${paper.stats.sells}회 · 승 ${paper.stats.wins}/패 ${paper.stats.losses} (승률 ${Math.round((paper.stats.wins / paper.stats.sells) * 100)}%)`,
                        ]
                      : []),
                  ];
                  return (
                    <Typography size={12} as="p" className="server-ai-symbol__paper-detail">
                      {parts.join(' · ')}
                    </Typography>
                  );
                })()}
                <div className="server-ai-symbol__fields">
                  <NumberField
                    label="목표"
                    unit="%"
                    value={s.targetPercent}
                    min={0.1}
                    max={100}
                    onChange={(v) => updateSymbol(index, { targetPercent: v })}
                  />
                  <NumberField
                    label="손절"
                    unit="%"
                    value={s.stopLossPercent}
                    min={0.1}
                    max={100}
                    onChange={(v) => updateSymbol(index, { stopLossPercent: v })}
                  />
                  <NumberField
                    label="트레일링"
                    unit="%"
                    value={s.trailingStopPercent}
                    min={0}
                    max={100}
                    onChange={(v) => updateSymbol(index, { trailingStopPercent: v })}
                  />
                  <NumberField
                    label="실거래 풀"
                    unit="$"
                    value={s.poolUsd}
                    min={50}
                    max={100000}
                    onChange={(v) => updateSymbol(index, { poolUsd: v })}
                  />
                  <label className="server-ai-symbol__live-toggle">
                    <Typography size={10} className="ui-textfield__label">실거래</Typography>
                    <Switch
                      checked={s.live}
                      onChange={(checked) => toggleLive(index, checked)}
                      aria-label={`${s.symbol} 실거래(배정 풀 실제 주문)`}
                    />
                  </label>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="server-ai-loss-limit">
          <NumberField
            label="일일 손실 한도 (전 종목 합산, 0=끔)"
            unit="$"
            value={draft.dailyLossLimitUsd}
            min={0}
            max={1_000_000}
            onChange={(v) => setDraft((c) => ({ ...c, dailyLossLimitUsd: v }))}
          />
          <div
            className="auto-trade__option"
            title="변동성(ATR) 동적 목표/손절 — 5분 판단 틱마다 종목별 ATR 로 목표(2×ATR, 설정×3 이내)·손절(1.5×ATR, 설정 이하)을 자동 조정합니다. 손절은 각 종목 설정보다 타이트해질 수만 있습니다."
          >
            <Typography size={12} className="auto-trade__option-label">ATR 자동</Typography>
            <Switch
              checked={Boolean(draft.atrLevels)}
              onChange={(checked) => setDraft((c) => ({ ...c, atrLevels: checked }))}
              aria-label="변동성(ATR) 동적 목표/손절 (5분 판단 틱 기준)"
            />
          </div>
        </div>
      </section>

      {/* 백그라운드(위) ↔ 단일 종목 집중(아래) 영역 구분선 */}
      <hr className="server-ai-divider" aria-hidden="true" />

      {/* 단일 종목 집중(서버 실주문) — 현재 실행 중인 종목의 진행 상황·결과 */}
      <LiveTraderSection
        openLogRequest={openLiveLog}
        onOpenLogConsumed={onLiveLogConsumed}
        onNavigateToSymbol={onNavigateToSymbol}
      />
        </div>

      {/* 판단 로그(종합) — 데스크톱 3열 배치의 가운데 열(종목 필터 칩).
          모바일은 화면 절약을 위해 숨기고, 종목 카드의 '로그' 버튼 → 모달로 종목별만 본다. */}
      {!isMobile && (
        <section className="panel server-ai-card server-ai-columns__logs" aria-label="판단 로그">
          <div className="server-ai-card__head">
            <Typography size={16} as="h2">판단 로그</Typography>
            <Button size="sm" variant="ghost" onClick={() => void refresh()}>
              새로고침
            </Button>
          </div>
          {draft.symbols.length > 0 && (
            <div className="server-ai-log-filter" role="tablist" aria-label="판단 로그 종목 필터">
              <Chip selected={logFilter === 'ALL'} onClick={() => setLogFilter('ALL')}>
                전체
              </Chip>
              {draft.symbols.map((s) => (
                <Chip
                  key={s.symbol}
                  selected={logFilter === s.symbol}
                  onClick={() => setLogFilter(s.symbol)}
                >
                  {s.symbol}
                </Chip>
              ))}
            </div>
          )}
          {/* 종목 선택 시: 판단 시점 가격 흐름 미니 차트(평단가 점선 포함) */}
          {logFilter !== 'ALL' && (
            <LogSparkline
              entries={logs.filter((l) => l.symbol === logFilter)}
              avgPrice={sparkAvgFor(logFilter)}
            />
          )}
          <LogList
            entries={logFilter !== 'ALL' ? logs.filter((l) => l.symbol === logFilter) : logs}
            emptyText={
              logFilter !== 'ALL'
                ? `${logFilter} 판단 기록이 아직 없습니다.`
                : '아직 기록이 없습니다. 엔진이 켜져 있고 미국장이 열려 있으면 5분마다 판단이 쌓입니다.'
            }
          />
        </section>
      )}
      </div>

      {/* 판단 로그 모달(모바일) — 데스크톱 로그 패널 전체를 모달로.
          종목 필터 칩이 있어 모달을 닫지 않고도 다른 종목 로그로 바로 전환할 수 있다. */}
      {logModalOpen && (
        <div
          className="backtest-modal__overlay"
          onClick={() => setLogModalOpen(false)}
          role="presentation"
        >
          <div
            className="backtest-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="판단 로그"
          >
            <div className="backtest-modal__head">
              <Typography size={16} as="h2" className="backtest-modal__title">
                판단 로그
              </Typography>
              <button
                type="button"
                className="backtest-modal__close"
                onClick={() => setLogModalOpen(false)}
                aria-label="닫기"
              >
                ✕
              </button>
            </div>
            <div className="backtest-modal__body server-ai-log-modal__body">
              {draft.symbols.length > 0 && (
                <div className="server-ai-log-filter" role="tablist" aria-label="판단 로그 종목 필터">
                  <Chip selected={logFilter === 'ALL'} onClick={() => setLogFilter('ALL')}>
                    전체
                  </Chip>
                  {draft.symbols.map((s) => (
                    <Chip
                      key={s.symbol}
                      selected={logFilter === s.symbol}
                      onClick={() => setLogFilter(s.symbol)}
                    >
                      {s.symbol}
                    </Chip>
                  ))}
                </div>
              )}
              {logFilter !== 'ALL' && (
                <LogSparkline
                  entries={logs.filter((l) => l.symbol === logFilter)}
                  avgPrice={sparkAvgFor(logFilter)}
                />
              )}
              <LogList
                entries={logFilter !== 'ALL' ? logs.filter((l) => l.symbol === logFilter) : logs}
                emptyText={
                  logFilter !== 'ALL'
                    ? `${logFilter} 판단 기록이 아직 없습니다.`
                    : '아직 기록이 없습니다.'
                }
              />
            </div>
          </div>
        </div>
      )}
    </main>
  );

  // 임베드(모바일 AI 탭)는 StockPage 레이아웃이 이미 사이드바를 제공 → 본문만.
  if (embedded) return content;

  // 데스크톱 독립 페이지: 트레이딩 화면과 동일한 우측 포트폴리오 사이드바를 함께 렌더.
  return (
    <div className="server-ai-layout">
      {content}
      <ServerAiSidebar />
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  type AutoEngineStatus,
  type AutoLogEntry,
  type AutoSymbolConfig,
  type AutoTradeConfig,
  type AutoTradeLimits,
  type PaperSummary,
} from '../../shared/api/client';
import { Button } from '../../shared/ui/Button';
import { Chip } from '../../shared/ui/Chip';
import { Switch } from '../../shared/ui/Switch';
import { TextField } from '../../shared/ui/TextField';
import { Typography } from '../../shared/ui/Typography';
import { NumberField } from '../../widgets/NumberField';
import { useToast } from '../../app/providers/ToastContext';

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

const EMPTY_CONFIG: AutoTradeConfig = { enabled: false, dailyLossLimitUsd: 0, symbols: [] };

/** 판단 로그 목록 — 로그 카드(전체/필터)와 종목별 모달이 공유하는 렌더러. */
function LogList({ entries, emptyText }: { entries: AutoLogEntry[]; emptyText: string }) {
  if (entries.length === 0) {
    return (
      <Typography size={14} as="p" className="hint">
        {emptyText}
      </Typography>
    );
  }
  return (
    <ul className="server-ai-logs">
      {entries.map((log) => (
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
          </div>
          <Typography size={14} as="p" className="server-ai-log__reason">
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
      ))}
    </ul>
  );
}

/**
 * 백그라운드 AI 매매 페이지 — 서버 상주(브라우저 불필요) 자동매매 엔진의 관리·모니터링 화면.
 * 현재 엔진은 드라이런: 판단·계획만 기록하고 실주문은 내지 않는다.
 * embedded=true 면 모바일 하단 탭('AI 봇') 안에 임베드 — 제목/뒤로가기 헤더를 생략한다.
 */
export function ServerAiPage({ embedded = false }: { embedded?: boolean } = {}) {
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
  const [logModalSymbol, setLogModalSymbol] = useState<string | null>(null);

  // 모달 열림 중 Esc 닫기 + 배경 스크롤 잠금.
  useEffect(() => {
    if (!logModalSymbol) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLogModalSymbol(null);
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [logModalSymbol]);

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
          targetPercent: 1,
          stopLossPercent: 3,
          trailingStopPercent: 0,
          buyMaxPercent: limits.maxBuyPercent,
        },
      ],
    }));
    setNewSymbol('');
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

  return (
    <main className={`server-ai-page${embedded ? ' server-ai-page--embedded' : ''}`}>
      {!embedded && (
        <div className="backtest-head">
          <Typography size={18} as="h1">백그라운드 AI 매매</Typography>
          <Link to="/" className="backtest-back">
            ← 트레이딩으로
          </Link>
        </div>
      )}

      <Typography size={14} as="p" className="hint server-ai-intro">
        브라우저를 꺼도 서버가 <strong>미국장이 열려 있는 동안</strong>(데이·프리·정규·애프터)
        5분봉 마감마다 등록 종목을 AI로 판단합니다. 현재는 <strong>드라이런 단계</strong>로 실제
        주문 없이, 종목마다 <strong>가상 $1,000</strong> 로 모의 매매(수수료 반영)해 수익률을
        추적합니다.
      </Typography>

      {loadError && <div className="banner error">{loadError}</div>}

      {/* 엔진 상태 + 킬스위치 */}
      <section className="panel server-ai-card" aria-label="엔진 상태">
        <div className="server-ai-card__head">
          <Typography size={16} as="h2">엔진 상태</Typography>
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
                    <Typography size={14} className="server-ai-symbol__name">{s.symbol}</Typography>
                    {(() => {
                      const paper = paperBySymbol.get(s.symbol);
                      if (!paper) return null;
                      const sign = paper.returnPct > 0 ? '+' : '';
                      const tone =
                        paper.returnPct > 0 ? 'is-up' : paper.returnPct < 0 ? 'is-down' : '';
                      return (
                        <span className={`server-ai-symbol__paper ${tone}`}>
                          {sign}
                          {paper.returnPct.toFixed(2)}%
                        </span>
                      );
                    })()}
                  </div>
                  <div className="server-ai-symbol__controls">
                    {isMobile && (
                      <Button size="sm" variant="ghost" onClick={() => setLogModalSymbol(s.symbol)}>
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
                    label="1회 매수"
                    unit="%"
                    value={s.buyMaxPercent}
                    min={0.1}
                    max={limits.maxBuyPercent}
                    onChange={(v) => updateSymbol(index, { buyMaxPercent: v })}
                  />
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
        </div>
      </section>

      {/* 판단 로그 — 데스크톱은 종목 필터 칩, 모바일은 전체 로그(종목별은 카드의 '로그' 모달) */}
      <section className="panel server-ai-card" aria-label="판단 로그">
        <div className="server-ai-card__head">
          <Typography size={16} as="h2">판단 로그</Typography>
          <Button size="sm" variant="ghost" onClick={() => void refresh()}>
            새로고침
          </Button>
        </div>
        {!isMobile && draft.symbols.length > 0 && (
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
        <LogList
          entries={
            !isMobile && logFilter !== 'ALL'
              ? logs.filter((l) => l.symbol === logFilter)
              : logs
          }
          emptyText={
            !isMobile && logFilter !== 'ALL'
              ? `${logFilter} 판단 기록이 아직 없습니다.`
              : '아직 기록이 없습니다. 엔진이 켜져 있고 미국장이 열려 있으면 5분마다 판단이 쌓입니다.'
          }
        />
      </section>

      {/* 종목별 로그 모달(모바일) */}
      {logModalSymbol && (
        <div
          className="backtest-modal__overlay"
          onClick={() => setLogModalSymbol(null)}
          role="presentation"
        >
          <div
            className="backtest-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={`${logModalSymbol} 판단 로그`}
          >
            <div className="backtest-modal__head">
              <Typography size={16} as="h2" className="backtest-modal__title">
                판단 로그 · {logModalSymbol}
              </Typography>
              <button
                type="button"
                className="backtest-modal__close"
                onClick={() => setLogModalSymbol(null)}
                aria-label="닫기"
              >
                ✕
              </button>
            </div>
            <div className="backtest-modal__body server-ai-log-modal__body">
              <LogList
                entries={logs.filter((l) => l.symbol === logModalSymbol)}
                emptyText={`${logModalSymbol} 판단 기록이 아직 없습니다.`}
              />
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

import { exec } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';

/**
 * LLM(Claude) 실시간 매매 판단.
 *
 * 안전 원칙:
 *  - 모델은 BUY/SELL/HOLD '제안'만 한다. 손절·1회 한도·쿨다운·킬스위치·탭가시성 등
 *    하드 가드는 클라이언트(코드)에서 강제하며, 모델이 이를 우회할 수 없다.
 *  - 거부(refusal)·오류·미설정 등 어떤 실패든 fail-safe = HOLD(아무것도 안 함)로 폴백.
 *  - 자격증명은 서버 .env 에만 둔다. 클라이언트로 노출하지 않는다.
 *
 * 인증 경로(둘 중 하나):
 *  - ANTHROPIC_API_KEY: Messages API 직접 호출(종량제 과금).
 *  - CLAUDE_CODE_OAUTH_TOKEN: `claude setup-token`으로 발급한 구독(OAuth) 토큰.
 *    Claude Agent SDK 경유로 호출하며 Max/Pro 구독 사용량에서 차감된다.
 *    둘 다 있으면 API 키가 우선(기존 동작 유지).
 */

export type AiAction = 'BUY' | 'SELL' | 'HOLD';

export interface AiDecisionCandle {
  t: number; // epoch sec (봉 시작)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface AiDecisionRequest {
  symbol: string;
  interval: string;
  currency?: string;
  currentPrice: number;
  previousClose?: number;
  dayChangePct?: number;
  position?: { quantity: number; averagePrice: number; profitLossPct?: number };
  buyingPower?: number;
  maxBuyQuantity?: number;
  sellableQuantity?: number;
  targetProfitPct?: number;
  stopLossPct?: number;
  signal?: { level?: string; score?: number; rsi?: number; sma20?: number; sma50?: number; atr?: number };
  /** 시장 국면 — ADX 기반(추세장/횡보장/전환). 전략 스위칭 컨텍스트. */
  regime?: { adx?: number; state?: string };
  /** 시장 전체 맥락 — 지수 ETF(QQQ 등)의 최근 흐름. */
  marketRef?: { symbol: string; movePct30m?: number; trendState?: string };
  trend?: { state?: string; confirmedBars?: number };
  orderbook?: {
    bestBid?: number;
    bestAsk?: number;
    bidRatio?: number;
    /** 상위 호가 심도(최대 5단). p=가격, q=잔량. */
    bids?: { p: number; q: number }[];
    asks?: { p: number; q: number }[];
  };
  /** 이 종목의 미체결 주문 — 중복 진입/청산 판단에 사용. */
  openOrders?: { side: 'BUY' | 'SELL'; price?: number; quantity?: number }[];
  /** 직전 AI 판단 이력(최근→과거). 일관성 있는 연속 판단 + 결과 피드백(적중 여부)에 사용. */
  history?: {
    t: number; // epoch ms
    action: string;
    confidence?: number;
    executed?: boolean;
    reason?: string;
    /** 판단 시점 가격 — 이후 변동률 계산용. */
    priceAtDecision?: number;
    /** 판단 이후 현재까지 가격 변동(%) — 판단이 맞았는지의 피드백. */
    moveSincePct?: number;
  }[];
  /** 코드가 강제하는 가드 상태 — 모델이 상황을 이해하고 무리한 제안을 줄이도록 제공. */
  guards?: {
    trailingStopPct?: number;
    buyMaxPercent?: number;
    dailyLossLimitUsd?: number;
    dailyRealizedUsd?: number;
  };
  candles: AiDecisionCandle[];
}

export interface AiDecision {
  action: AiAction;
  /** 진입/청산 제안 비중(%). 클라이언트가 자체 상한으로 다시 캡한다. */
  sizePct: number;
  /** 확신도 0~1. */
  confidence: number;
  reason: string;
  model: string;
  /** LLM 호출이 아니라 폴백(미설정/오류/거부)으로 만든 결정인지. */
  fallback?: boolean;
}

const MODEL = 'claude-opus-4-8';
const MAX_CANDLES = 40;

const SYSTEM_PROMPT = `당신은 미국 주식 단기 매매를 보조하는 규율 있는 모멘텀 트레이딩 판단 엔진입니다.
입력으로 한 종목의 최근 '완성된' 캔들(OHLCV)·지표·추세·호가 심도·보유 상태·미체결 주문·
직전 판단 이력·앱의 가드 상태를 받습니다.
음봉/양봉 추세, 모멘텀(RSI), 이동평균 배열, 거래량, 변동성(ATR), 호가 균형·심도를 종합해
"지금 이 봉 마감 시점"에 취할 행동을 BUY / SELL / HOLD 중 하나로 제안합니다.

원칙:
- 적극적으로 기회를 포착합니다. 방향 근거가 있으면 진입/청산을 제안하고, HOLD 는 신호가 없거나
  근거가 서로 상충할 때만 선택합니다. "확정을 기다리느라 기회를 흘려보내는 것"도 비용입니다.
- 매수(BUY)는 공격적으로 판단합니다. 보유가 없는 상태에서 추세가 '명백한 하락'이 아니라면
  (횡보·약보합·눌림 후 첫 반등 조짐·중립 이상) 소량(sizePct 낮게) 선진입을 기본값으로 고려하세요.
  강한 상승 확정을 끝까지 기다리지 말고, 반등 조짐 1봉 + 거래량 또는 호가 매수우위 중 하나만
  동반돼도 진입을 제안합니다. 무포지션으로 상승을 흘려보내는 것은 명백한 비용입니다.
- 확신이 쌓이면 sizePct 를 키워 표현합니다(상한은 앱이 캡). 확신이 낮아도 근거가 조금이라도
  상방이면 소량 진입이지 HOLD 가 아닙니다. 신규 매수를 막는 것은 '명백한 하락 추세·모멘텀 악화·
  급등 직후 고점'일 때로 한정합니다.
- 손절·한도·쿨다운·킬스위치 같은 안전장치는 앱이 코드로 강제합니다. 방향 제안을 지나치게 망설일
  필요가 없습니다 — 틀리면 손절이 지켜줍니다. 진입 문턱을 낮게 잡으세요.
- 다만 두 가지는 피합니다: 급등 마지막 봉 고점 추격, 그리고 직전 판단의 무근거 뒤집기.
  직전 판단을 뒤집을 때는 새 근거(추세 전환·급변)를 reason 에 명시하세요.
- 시장 국면에 전략을 맞추세요: '추세장'(ADX≥25)에서는 추세추종 — 눌림 매수와 추세 유지에
  무게를 두고, '횡보장'(ADX<20)에서는 평균회귀 — 박스 하단 반등 매수·상단 이익 실현 위주로,
  돌파 추격은 자제합니다. '전환' 구간은 확증을 더 요구하세요.
- 시장 맥락(QQQ 등 지수 흐름)이 급락 중이면 개별 종목 신규 매수는 보수적으로, 지수와 같은
  방향의 신호에는 신뢰를 더하세요.
- 직전 판단 이력의 '이후 변동'은 내 판단의 적중 피드백입니다. 최근 같은 방향 판단이 반복해서
  반대로 움직였다면(예: BUY 후 연속 하락) 같은 근거의 재진입에는 더 강한 확증을 요구하고
  confidence 를 낮추세요. 반대로 판단이 잘 맞고 있으면 일관성을 유지하세요.
- 보유 중 목표 수익률/손절률 부근이거나 추세가 꺾이면 청산(SELL) 제안을 주저하지 않습니다.
- 같은 방향의 미체결 주문이 이미 있으면 중복 진입(BUY)·중복 청산(SELL)을 제안하지 않습니다.
- 보유 중이어도 매도가능 수량이 0이면(비정규장 소수점 잔량 등) SELL 을 제안하지 않습니다 —
  실행이 불가능하므로 HOLD 를 선택하고, 필요하면 reason 에 "정규장에서 청산 권장"을 남기세요.
- 일일 실현 손실이 한도에 근접해 있으면 신규 진입(BUY)에 더 엄격한 기준을 적용합니다.
- sizePct 는 제안 비중(%)이며 앱이 자체 상한으로 다시 제한합니다. confidence 는 0~1.
- reason 은 한국어 1~2문장으로 핵심 근거만 적습니다(지표/봉 형태 위주).
- 반드시 지정된 JSON 스키마로만 답합니다.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['BUY', 'SELL', 'HOLD'] },
    sizePct: { type: 'number' },
    confidence: { type: 'number' },
    reason: { type: 'string' },
  },
  required: ['action', 'sizePct', 'confidence', 'reason'],
  additionalProperties: false,
} as const;

export type AiAuthMode = 'api-key' | 'subscription';

export function getAiAuthMode(): AiAuthMode | null {
  if (process.env.ANTHROPIC_API_KEY?.trim()) return 'api-key';
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return 'subscription';
  return null;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

export function isAiConfigured(): boolean {
  return getAiAuthMode() !== null;
}

function holdFallback(reason: string, model = MODEL): AiDecision {
  return { action: 'HOLD', sizePct: 0, confidence: 0, reason, model, fallback: true };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function buildUserPrompt(req: AiDecisionRequest): string {
  const candles = (req.candles ?? []).slice(-MAX_CANDLES);
  // 봉을 한 줄씩 압축(시각 생략, 시가>종가 음봉 표시) — 토큰 절약 + 추세 가독성.
  const candleLines = candles
    .map((c) => {
      const dir = c.c >= c.o ? '양' : '음';
      return `${dir} O${c.o} H${c.h} L${c.l} C${c.c} V${c.v}`;
    })
    .join('\n');

  const pos = req.position && req.position.quantity > 0
    ? `보유 ${req.position.quantity}주 @ 평단 ${req.position.averagePrice}` +
      (req.position.profitLossPct !== undefined ? ` (평가손익 ${req.position.profitLossPct.toFixed(2)}%)` : '')
    : '보유 없음';

  return [
    `종목: ${req.symbol} (${req.currency ?? 'USD'}), 캔들 간격: ${req.interval}`,
    `현재가: ${req.currentPrice}` +
      (req.previousClose !== undefined ? `, 전일종가: ${req.previousClose}` : '') +
      (req.dayChangePct !== undefined ? `, 당일 ${req.dayChangePct.toFixed(2)}%` : ''),
    pos,
    req.buyingPower !== undefined ? `주문가능: ${req.buyingPower}` : '',
    req.maxBuyQuantity !== undefined ? `최대매수: ${req.maxBuyQuantity}주` : '',
    req.sellableQuantity !== undefined ? `매도가능: ${req.sellableQuantity}주` : '',
    req.targetProfitPct !== undefined || req.stopLossPct !== undefined
      ? `목표 +${req.targetProfitPct ?? '-'}% / 손절 -${req.stopLossPct ?? '-'}%`
      : '',
    req.signal
      ? `신호: ${req.signal.level ?? '-'}(score ${req.signal.score ?? '-'}), RSI ${req.signal.rsi ?? '-'}, ` +
        `SMA20 ${req.signal.sma20 ?? '-'}, SMA50 ${req.signal.sma50 ?? '-'}, ATR ${req.signal.atr ?? '-'}`
      : '',
    req.trend ? `추세: ${req.trend.state ?? '-'}(확정봉 ${req.trend.confirmedBars ?? 0})` : '',
    req.regime
      ? `시장 국면: ${req.regime.state ?? '-'}${req.regime.adx !== undefined ? ` (ADX ${req.regime.adx})` : ''}`
      : '',
    req.marketRef
      ? `시장 맥락(${req.marketRef.symbol}): 최근 30분 ${req.marketRef.movePct30m !== undefined ? `${req.marketRef.movePct30m >= 0 ? '+' : ''}${req.marketRef.movePct30m.toFixed(2)}%` : '-'}${req.marketRef.trendState ? `, 추세 ${req.marketRef.trendState}` : ''}`
      : '',
    req.orderbook
      ? `호가: 매수1 ${req.orderbook.bestBid ?? '-'} / 매도1 ${req.orderbook.bestAsk ?? '-'}` +
        (req.orderbook.bidRatio !== undefined ? `, 매수비중 ${(req.orderbook.bidRatio * 100).toFixed(0)}%` : '')
      : '',
    req.orderbook?.bids?.length
      ? `매수 심도(상위): ${req.orderbook.bids.map((l) => `${l.p}×${l.q}`).join(' ')}`
      : '',
    req.orderbook?.asks?.length
      ? `매도 심도(상위): ${req.orderbook.asks.map((l) => `${l.p}×${l.q}`).join(' ')}`
      : '',
    req.openOrders?.length
      ? `미체결 주문: ${req.openOrders
          .map((o) => `${o.side === 'BUY' ? '매수' : '매도'} ${o.quantity ?? '-'}주 @ ${o.price ?? '시장가'}`)
          .join(', ')}`
      : '미체결 주문 없음',
    req.guards
      ? `가드: 트레일링 ${req.guards.trailingStopPct ? `-${req.guards.trailingStopPct}%` : '없음'}, ` +
        `1회 매수 상한 ${req.guards.buyMaxPercent ?? '-'}%` +
        (req.guards.dailyLossLimitUsd
          ? `, 일일손실한도 $${req.guards.dailyLossLimitUsd} (오늘 실현 ${req.guards.dailyRealizedUsd?.toFixed(2) ?? 0}$)`
          : '')
      : '',
    req.history?.length
      ? `직전 판단(최근→과거, '이후'=판단 이후 현재까지 가격 변동): ${req.history
          .slice(0, 8)
          .map(
            (h) =>
              `${h.action}${h.confidence !== undefined ? `(${(h.confidence * 100).toFixed(0)}%)` : ''}${h.executed ? '·실행됨' : ''}${
                h.moveSincePct !== undefined
                  ? `·이후 ${h.moveSincePct >= 0 ? '+' : ''}${h.moveSincePct.toFixed(2)}%`
                  : ''
              }`
          )
          .join(' → ')}`
      : '',
    '',
    `최근 완성봉(오래된→최근, 최대 ${MAX_CANDLES}개):`,
    candleLines || '(캔들 없음)',
    '',
    '지금 봉 마감 시점의 행동을 스키마에 맞춰 제안하세요.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 모델 응답(JSON 객체)을 안전 범위로 정규화 — 두 인증 경로가 공유. */
function normalizeDecision(
  parsed: { action?: unknown; sizePct?: unknown; confidence?: unknown; reason?: unknown },
  model: string
): AiDecision {
  const action: AiAction =
    parsed.action === 'BUY' || parsed.action === 'SELL' ? parsed.action : 'HOLD';
  return {
    action,
    sizePct: clampNumber(parsed.sizePct, 0, 100, 0),
    confidence: clampNumber(parsed.confidence, 0, 1, 0),
    reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 300) : '',
    model,
  };
}

/** Agent SDK 호출 상한 — CLI 스폰 + 추론까지 포함하므로 여유 있게. */
const AGENT_SDK_TIMEOUT_MS = 90_000;

let agentSdkModule: Promise<typeof import('@anthropic-ai/claude-agent-sdk')> | null = null;
function loadAgentSdk() {
  // 구독 경로를 쓰지 않는 서버에서 무거운 모듈을 로드하지 않도록 지연 로드.
  agentSdkModule ??= import('@anthropic-ai/claude-agent-sdk');
  return agentSdkModule;
}

/**
 * 구독(OAuth) 경로 — Claude Agent SDK(query)로 단발 호출.
 * 도구·세션 저장 없이 JSON 스키마 출력만 받는다. 인증은 CLAUDE_CODE_OAUTH_TOKEN 환경변수를
 * SDK가 스폰하는 Claude Code 런타임이 그대로 상속해서 처리한다.
 */
async function decideViaSubscription(req: AiDecisionRequest): Promise<AiDecision> {
  const { query } = await loadAgentSdk();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), AGENT_SDK_TIMEOUT_MS);
  try {
    const stream = query({
      prompt: buildUserPrompt(req),
      options: {
        model: MODEL,
        systemPrompt: SYSTEM_PROMPT,
        maxTurns: 1,
        tools: [],
        permissionMode: 'dontAsk',
        settingSources: [],
        persistSession: false,
        outputFormat: { type: 'json_schema', schema: OUTPUT_SCHEMA as unknown as Record<string, unknown> },
        abortController: abort,
      },
    });

    for await (const message of stream) {
      if (message.type !== 'result') continue;
      if (message.subtype !== 'success') {
        const detail = message.errors?.length ? message.errors.join('; ') : message.subtype;
        return holdFallback(`AI 호출 실패(${detail}) — 보류`);
      }
      let raw: unknown = message.structured_output;
      if (raw === undefined && typeof message.result === 'string') {
        try {
          raw = JSON.parse(message.result);
        } catch {
          return holdFallback('AI 응답 파싱 실패 — 보류');
        }
      }
      if (!raw || typeof raw !== 'object') {
        return holdFallback('AI 응답 없음 — 보류');
      }
      return normalizeDecision(raw as Record<string, unknown>, MODEL);
    }
    return holdFallback('AI 응답 없음 — 보류');
  } catch (error) {
    const message = abort.signal.aborted
      ? `시간 초과(${AGENT_SDK_TIMEOUT_MS / 1000}s)`
      : error instanceof Error
        ? error.message
        : '알 수 없는 오류';
    return holdFallback(`AI 호출 실패: ${message} — 보류`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 구독 경로 동시 실행 제한 — 호출마다 Claude Code 런타임 프로세스(수백 MB)가 뜨므로
 * 저사양 인스턴스 보호를 위해 항상 1개씩 순차 실행한다. 대기열이 가득 차면
 * 즉시 HOLD 폴백(봉이 이미 지나간 뒤의 늦은 판단은 가치가 없다).
 *
 * 슬롯 누수 방지: abort 가 스트림을 끝내지 못해 호출이 영원히 매달리면 슬롯이
 * 반환되지 않아 이후 모든 판단이 "동시 요청 초과"로 즉시 거절된다(실제 발생).
 * 실행 단계에 하드 타임아웃을 걸어 어떤 경우에도 슬롯이 회수되게 한다.
 */
const MAX_PENDING_SUBSCRIPTION_CALLS = 4; // 실행 중 1 + 대기 3(서버 엔진 2종목 + 클라이언트 여유)
/** 실행 시작 후 이 시간 안에 무조건 결론(폴백 포함) — SDK 타임아웃 + 여유. */
const SUBSCRIPTION_HARD_TIMEOUT_MS = AGENT_SDK_TIMEOUT_MS + 15_000;
let pendingSubscriptionCalls = 0;
let subscriptionChain: Promise<unknown> = Promise.resolve();

/**
 * 매달린 Claude Code 런타임(네이티브 'claude' 바이너리, 개당 수백 MB) 강제 정리.
 * abort 가 안 먹은 좀비가 누적되면 인스턴스 메모리가 고갈돼 서버 전체가 먹통이 된다(실제 장애).
 * 구독 호출은 직렬 실행이라 이 시점에 떠 있는 claude 프로세스는 매달린 호출(+이전 좀비)뿐이다.
 * 정리 후 잠시 기다렸다가 폴백을 돌려 다음 호출이 새 프로세스와 경합하지 않게 한다.
 */
function killStaleClaudeRuntimes(onDone: () => void): void {
  exec('pkill -9 -x claude', () => setTimeout(onDone, 500));
}

/** 실행 하드 타임아웃 — 내부 abort 실패로 스트림이 안 끝나도 폴백으로 정리(never-reject). */
function runWithHardTimeout(req: AiDecisionRequest): Promise<AiDecision> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.error('[ai] 구독 호출 무응답 — 하드 타임아웃: 런타임 프로세스 정리 후 슬롯 회수');
      killStaleClaudeRuntimes(() =>
        resolve(holdFallback('AI 호출 무응답(하드 타임아웃) — 보류'))
      );
    }, SUBSCRIPTION_HARD_TIMEOUT_MS);
    decideViaSubscription(req).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        resolve(
          holdFallback(
            `AI 호출 실패: ${error instanceof Error ? error.message : '알 수 없는 오류'} — 보류`
          )
        );
      }
    );
  });
}

/** 구독 대기열의 범용 등록 — 판단/분석 등 모든 구독 호출이 같은 직렬 체인·상한을 공유한다. */
function queueSubscriptionTask<T>(run: () => Promise<T>, overflow: () => T): Promise<T> {
  if (pendingSubscriptionCalls >= MAX_PENDING_SUBSCRIPTION_CALLS) {
    console.error(`[ai] 구독 대기열 초과(pending=${pendingSubscriptionCalls}) — 폴백`);
    return Promise.resolve(overflow());
  }
  pendingSubscriptionCalls += 1;
  const result = subscriptionChain.then(run, run).finally(() => {
    pendingSubscriptionCalls -= 1;
  });
  subscriptionChain = result.catch(() => undefined);
  return result;
}

function queueSubscriptionDecision(req: AiDecisionRequest): Promise<AiDecision> {
  return queueSubscriptionTask(
    () => runWithHardTimeout(req),
    () => holdFallback('AI 판단 동시 요청 초과 — 보류')
  );
}

export async function getAiTradeDecision(req: AiDecisionRequest): Promise<AiDecision> {
  const authMode = getAiAuthMode();
  if (!authMode) {
    return holdFallback(
      'AI 미설정(ANTHROPIC_API_KEY 또는 CLAUDE_CODE_OAUTH_TOKEN 없음) — 자동 판단 비활성',
      'unconfigured'
    );
  }
  if (!req.currentPrice || !Number.isFinite(req.currentPrice) || !(req.candles?.length)) {
    return holdFallback('입력 데이터 부족 — 판단 보류');
  }

  if (authMode === 'subscription') {
    return queueSubscriptionDecision(req);
  }

  try {
    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: 2048,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: buildUserPrompt(req) }],
    } as Anthropic.MessageCreateParamsNonStreaming);

    if (response.stop_reason === 'refusal') {
      return holdFallback('AI 판단 거부(refusal) — 보류');
    }

    const textBlock = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === 'text'
    );
    if (!textBlock?.text) {
      return holdFallback('AI 응답 없음 — 보류');
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(textBlock.text);
    } catch {
      return holdFallback('AI 응답 파싱 실패 — 보류');
    }

    return normalizeDecision(parsed, response.model ?? MODEL);
  } catch (error) {
    const message = error instanceof Error ? error.message : '알 수 없는 오류';
    return holdFallback(`AI 호출 실패: ${message} — 보류`);
  }
}

// ── 백테스트 시나리오 분석(AI) ─────────────────────────────────────────
// 여러 (익절, 손절) 시나리오의 백테스트 요약을 받아 "실전 신뢰도"가 가장 높은
// 조합을 고른다. 판단 경로와 같은 모델·인증·구독 대기열을 공유한다.

export interface BacktestScenarioInput {
  targetPct: number;
  stopPct: number;
  trades: number;
  winRatePct: number;
  avgReturnPct: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
}

export interface BacktestAnalysisRequest {
  symbol: string;
  interval: string;
  forwardBars: number;
  costPct: number;
  usedCandles?: number;
  /** 누적 수익률 내림차순 정렬 가정(index 0 = 누적 1위) — 폴백 시 0을 고른다. */
  scenarios: BacktestScenarioInput[];
}

export interface BacktestAnalysis {
  bestIndex: number;
  reason: string;
  caution?: string;
  model: string;
  fallback?: boolean;
}

const BACKTEST_ANALYSIS_SYSTEM = `당신은 트레이딩 전략 백테스트 분석가입니다.
한 종목에 대해 여러 (익절%, 손절%) 시나리오의 백테스트 요약 통계를 받아,
실전에서 가장 신뢰할 만한 최적 시나리오 "하나"를 고릅니다.

원칙:
- 단순 누적수익 1위가 아니라 표본 수(거래 횟수), 승률, 평균 수익(기대값), 최대 낙폭(MDD),
  과최적화 위험(외딴 최고점보다 이웃 조합도 준수한 안정 구간 선호)을 종합해 판단합니다.
- 거래 횟수가 너무 적은 시나리오(대략 5회 미만)는 통계적으로 신뢰하지 않습니다.
- bestIndex 는 입력 배열의 0-기반 인덱스입니다.
- reason 은 한국어 2~3문장으로 선택 근거를, caution 은 주의점을 1문장으로(선택) 적습니다.
- 반드시 지정된 JSON 스키마로만 답합니다.`;

const BACKTEST_ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    bestIndex: { type: 'number' },
    reason: { type: 'string' },
    caution: { type: 'string' },
  },
  required: ['bestIndex', 'reason'],
  additionalProperties: false,
} as const;

function buildBacktestAnalysisPrompt(req: BacktestAnalysisRequest): string {
  const lines = req.scenarios.map(
    (s, i) =>
      `#${i} 익절 +${s.targetPct}% / 손절 -${s.stopPct}% | 거래 ${s.trades}회 | 승률 ${s.winRatePct.toFixed(1)}% | ` +
      `평균 ${s.avgReturnPct.toFixed(3)}% | 누적 ${s.totalReturnPct.toFixed(2)}% | MDD ${s.maxDrawdownPct.toFixed(2)}%p`
  );
  return [
    `종목 ${req.symbol}, 캔들 ${req.interval}, 평가 봉수 K=${req.forwardBars}, 왕복 비용 ${req.costPct}%` +
      (req.usedCandles ? `, 캔들 ${req.usedCandles}개` : ''),
    '',
    '시나리오(누적 수익 내림차순):',
    ...lines,
    '',
    '최적 시나리오 하나를 스키마에 맞춰 고르세요.',
  ].join('\n');
}

function analysisFallback(reason: string, model = 'fallback'): BacktestAnalysis {
  // 폴백은 누적 수익 1위(index 0)를 고른다 — 입력이 내림차순 정렬돼 있기 때문.
  return { bestIndex: 0, reason, model, fallback: true };
}

function normalizeAnalysis(
  parsed: Record<string, unknown>,
  scenarioCount: number,
  model: string
): BacktestAnalysis {
  const idxRaw = typeof parsed.bestIndex === 'number' ? parsed.bestIndex : Number(parsed.bestIndex);
  const bestIndex = Number.isFinite(idxRaw)
    ? Math.min(scenarioCount - 1, Math.max(0, Math.round(idxRaw)))
    : 0;
  return {
    bestIndex,
    reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 500) : '',
    caution: typeof parsed.caution === 'string' ? parsed.caution.slice(0, 300) : undefined,
    model,
  };
}

/** 구독 경로 — 판단(decideViaSubscription)과 동일한 단발 JSON 호출 패턴. */
async function analyzeViaSubscription(req: BacktestAnalysisRequest): Promise<BacktestAnalysis> {
  const { query } = await loadAgentSdk();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), AGENT_SDK_TIMEOUT_MS);
  try {
    const stream = query({
      prompt: buildBacktestAnalysisPrompt(req),
      options: {
        model: MODEL,
        systemPrompt: BACKTEST_ANALYSIS_SYSTEM,
        maxTurns: 1,
        tools: [],
        permissionMode: 'dontAsk',
        settingSources: [],
        persistSession: false,
        outputFormat: {
          type: 'json_schema',
          schema: BACKTEST_ANALYSIS_SCHEMA as unknown as Record<string, unknown>,
        },
        abortController: abort,
      },
    });

    for await (const message of stream) {
      if (message.type !== 'result') continue;
      if (message.subtype !== 'success') {
        const detail = message.errors?.length ? message.errors.join('; ') : message.subtype;
        return analysisFallback(`AI 분석 실패(${detail}) — 누적 1위 기준`);
      }
      let raw: unknown = message.structured_output;
      if (raw === undefined && typeof message.result === 'string') {
        try {
          raw = JSON.parse(message.result);
        } catch {
          return analysisFallback('AI 응답 파싱 실패 — 누적 1위 기준');
        }
      }
      if (!raw || typeof raw !== 'object') {
        return analysisFallback('AI 응답 없음 — 누적 1위 기준');
      }
      return normalizeAnalysis(raw as Record<string, unknown>, req.scenarios.length, MODEL);
    }
    return analysisFallback('AI 응답 없음 — 누적 1위 기준');
  } catch (error) {
    const message = abort.signal.aborted
      ? `시간 초과(${AGENT_SDK_TIMEOUT_MS / 1000}s)`
      : error instanceof Error
        ? error.message
        : '알 수 없는 오류';
    return analysisFallback(`AI 분석 실패: ${message} — 누적 1위 기준`);
  } finally {
    clearTimeout(timer);
  }
}

/** 하드 타임아웃 — 판단 경로와 동일하게 슬롯 누수·좀비 런타임을 방지한다. */
function analyzeWithHardTimeout(req: BacktestAnalysisRequest): Promise<BacktestAnalysis> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.error('[ai] 백테스트 분석 무응답 — 하드 타임아웃: 런타임 정리 후 슬롯 회수');
      killStaleClaudeRuntimes(() =>
        resolve(analysisFallback('AI 분석 무응답(하드 타임아웃) — 누적 1위 기준'))
      );
    }, SUBSCRIPTION_HARD_TIMEOUT_MS);
    analyzeViaSubscription(req).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        resolve(
          analysisFallback(
            `AI 분석 실패: ${error instanceof Error ? error.message : '오류'} — 누적 1위 기준`
          )
        );
      }
    );
  });
}

export async function getAiBacktestAnalysis(
  req: BacktestAnalysisRequest
): Promise<BacktestAnalysis> {
  if (!req.scenarios?.length) {
    return analysisFallback('시나리오 없음', 'none');
  }
  const authMode = getAiAuthMode();
  if (!authMode) {
    return analysisFallback('AI 미설정 — 누적 1위 기준', 'unconfigured');
  }

  if (authMode === 'subscription') {
    return queueSubscriptionTask(
      () => analyzeWithHardTimeout(req),
      () => analysisFallback('AI 동시 요청 초과 — 누적 1위 기준')
    );
  }

  try {
    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: BACKTEST_ANALYSIS_SCHEMA },
      },
      system: [{ type: 'text', text: BACKTEST_ANALYSIS_SYSTEM }],
      messages: [{ role: 'user', content: buildBacktestAnalysisPrompt(req) }],
    } as Anthropic.MessageCreateParamsNonStreaming);

    if (response.stop_reason === 'refusal') {
      return analysisFallback('AI 분석 거부 — 누적 1위 기준');
    }
    const textBlock = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === 'text'
    );
    if (!textBlock?.text) return analysisFallback('AI 응답 없음 — 누적 1위 기준');
    try {
      return normalizeAnalysis(
        JSON.parse(textBlock.text) as Record<string, unknown>,
        req.scenarios.length,
        response.model ?? MODEL
      );
    } catch {
      return analysisFallback('AI 응답 파싱 실패 — 누적 1위 기준');
    }
  } catch (error) {
    return analysisFallback(
      `AI 분석 실패: ${error instanceof Error ? error.message : '오류'} — 누적 1위 기준`
    );
  }
}

// ── 보유 종목 AI 브리핑 — 뉴스·공시·정보를 웹 검색으로 종합(구독 경로 전용) ──────
//
// 판단/분석과 달리 실시간 웹 검색(WebSearch 내장 도구)이 필요해 구독(Agent SDK)
// 경로에서만 지원한다. 보유 종목 전체를 한 번의 호출로 처리해 호출 수를 아끼고,
// 캐시(라우트 계층)로 접속마다 재호출되지 않게 한다.

export interface BriefingNewsItem {
  title: string;
  date?: string;
  impact?: 'positive' | 'negative' | 'neutral';
  note?: string;
}

export interface BriefingSymbolItem {
  symbol: string;
  summary: string;
  news: BriefingNewsItem[];
}

export interface AiBriefingResult {
  overall: string;
  items: BriefingSymbolItem[];
  model: string;
  fallback?: boolean;
}

/** 웹 검색 여러 라운드가 필요해 판단(90s)보다 길게 잡는다. */
const BRIEFING_TIMEOUT_MS = 180_000;
const BRIEFING_HARD_TIMEOUT_MS = BRIEFING_TIMEOUT_MS + 15_000;

const BRIEFING_SYSTEM = `너는 미국 주식 개인 투자자를 위한 브리핑 어시스턴트다.
WebSearch 도구로 각 종목의 최근 뉴스·공시(실적 발표, 가이던스, SEC 공시, 애널리스트 액션)와
예정된 이벤트(실적 발표일 등)를 확인해 한국어로 간결하게 정리한다.
규칙:
- 반드시 검색으로 확인한 내용만 쓴다. 확인 못 한 종목은 summary 에 "최근 확인된 주요 소식 없음"이라고 쓴다.
- 각 뉴스에는 가능한 한 날짜를 붙이고, 주가에 미칠 영향을 impact(positive/negative/neutral)로 표시한다.
- 과장·추측·투자 권유 금지. 사실 요약과 일정 안내만.
- 종목당 뉴스는 중요도 순 최대 3건.`;

const BRIEFING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['overall', 'items'],
  properties: {
    overall: {
      type: 'string',
      description: '보유 종목 전반·시장 분위기 종합 코멘트(한국어 2~4문장)',
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['symbol', 'summary', 'news'],
        properties: {
          symbol: { type: 'string' },
          summary: { type: 'string', description: '종목 현황 요약 2~3문장(한국어)' },
          news: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title'],
              properties: {
                title: { type: 'string' },
                date: { type: 'string', description: 'YYYY-MM-DD 또는 상대 표기' },
                impact: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
                note: { type: 'string', description: '한 줄 보충 설명(선택)' },
              },
            },
          },
        },
      },
    },
  },
} as const;

function buildBriefingPrompt(symbols: string[]): string {
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  return [
    `오늘(KST): ${today}`,
    `보유 종목: ${symbols.join(', ')}`,
    '',
    '위 미국 주식 종목들에 대해 WebSearch 로 최근 1~2주 뉴스·공시·예정 이벤트를 확인하고,',
    '종목별 summary(2~3문장)와 주요 뉴스(최대 3건), 전체 종합 코멘트(overall)를 JSON 으로 작성해줘.',
    '모든 종목을 빠짐없이 items 에 포함할 것.',
  ].join('\n');
}

function briefingFallback(reason: string): AiBriefingResult {
  return { overall: reason, items: [], model: 'fallback', fallback: true };
}

function normalizeBriefing(parsed: Record<string, unknown>, symbols: string[]): AiBriefingResult {
  const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
  const items: BriefingSymbolItem[] = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const symbol = typeof r.symbol === 'string' ? r.symbol.trim().toUpperCase() : '';
    if (!symbol) continue;
    const newsRaw = Array.isArray(r.news) ? r.news : [];
    const news: BriefingNewsItem[] = [];
    for (const n of newsRaw.slice(0, 5)) {
      if (!n || typeof n !== 'object') continue;
      const nn = n as Record<string, unknown>;
      if (typeof nn.title !== 'string' || !nn.title.trim()) continue;
      news.push({
        title: nn.title.slice(0, 200),
        date: typeof nn.date === 'string' ? nn.date.slice(0, 30) : undefined,
        impact:
          nn.impact === 'positive' || nn.impact === 'negative' || nn.impact === 'neutral'
            ? nn.impact
            : undefined,
        note: typeof nn.note === 'string' ? nn.note.slice(0, 300) : undefined,
      });
    }
    items.push({
      symbol,
      summary: typeof r.summary === 'string' ? r.summary.slice(0, 800) : '',
      news,
    });
  }
  // 요청 종목 순서로 정렬 + 누락 종목은 빈 항목으로 보충(빠짐없이 표시).
  const bySymbol = new Map(items.map((i) => [i.symbol, i]));
  const ordered = symbols.map(
    (s) => bySymbol.get(s) ?? { symbol: s, summary: '이번 브리핑에서 확인되지 않았습니다.', news: [] }
  );
  return {
    overall: typeof parsed.overall === 'string' ? parsed.overall.slice(0, 1200) : '',
    items: ordered,
    model: MODEL,
  };
}

async function briefViaSubscription(symbols: string[]): Promise<AiBriefingResult> {
  const { query } = await loadAgentSdk();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), BRIEFING_TIMEOUT_MS);
  try {
    const stream = query({
      prompt: buildBriefingPrompt(symbols),
      options: {
        model: MODEL,
        systemPrompt: BRIEFING_SYSTEM,
        // 검색 여러 라운드(종목 수만큼) 허용 — WebSearch 만 열어준다.
        // dontAsk 모드는 권한 요청을 자동 거부하므로 allowedTools 로 명시 허용해야 실제로 돈다.
        maxTurns: 25,
        tools: ['WebSearch'],
        allowedTools: ['WebSearch'],
        permissionMode: 'dontAsk',
        settingSources: [],
        persistSession: false,
        outputFormat: {
          type: 'json_schema',
          schema: BRIEFING_SCHEMA as unknown as Record<string, unknown>,
        },
        abortController: abort,
      },
    });

    for await (const message of stream) {
      if (message.type !== 'result') continue;
      if (message.subtype !== 'success') {
        const detail = message.errors?.length ? message.errors.join('; ') : message.subtype;
        return briefingFallback(`AI 브리핑 실패(${detail}) — 갱신을 다시 시도해주세요.`);
      }
      let raw: unknown = message.structured_output;
      if (raw === undefined && typeof message.result === 'string') {
        try {
          raw = JSON.parse(message.result);
        } catch {
          return briefingFallback('AI 응답 파싱 실패 — 갱신을 다시 시도해주세요.');
        }
      }
      if (!raw || typeof raw !== 'object') {
        return briefingFallback('AI 응답 없음 — 갱신을 다시 시도해주세요.');
      }
      return normalizeBriefing(raw as Record<string, unknown>, symbols);
    }
    return briefingFallback('AI 응답 없음 — 갱신을 다시 시도해주세요.');
  } catch (error) {
    const message = abort.signal.aborted
      ? `시간 초과(${BRIEFING_TIMEOUT_MS / 1000}s)`
      : error instanceof Error
        ? error.message
        : '알 수 없는 오류';
    return briefingFallback(`AI 브리핑 실패: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 하드 타임아웃 — 판단 경로와 동일하게 슬롯 누수·좀비 런타임을 방지한다. */
function briefWithHardTimeout(symbols: string[]): Promise<AiBriefingResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.error('[ai] 브리핑 무응답 — 하드 타임아웃: 런타임 정리 후 슬롯 회수');
      killStaleClaudeRuntimes(() => resolve(briefingFallback('AI 브리핑 무응답(하드 타임아웃)')));
    }, BRIEFING_HARD_TIMEOUT_MS);
    briefViaSubscription(symbols).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        resolve(
          briefingFallback(`AI 브리핑 실패: ${error instanceof Error ? error.message : '오류'}`)
        );
      }
    );
  });
}

export async function getAiMarketBriefing(symbols: string[]): Promise<AiBriefingResult> {
  if (symbols.length === 0) return briefingFallback('브리핑할 종목이 없습니다.');
  if (!isAiConfigured()) return briefingFallback('AI 미설정(CLAUDE_CODE_OAUTH_TOKEN 없음)');
  if (getAiAuthMode() !== 'subscription') {
    return briefingFallback('브리핑(웹 검색)은 구독(OAuth) 모드에서만 지원합니다.');
  }
  return queueSubscriptionTask(
    () => briefWithHardTimeout(symbols),
    () => briefingFallback('AI 동시 요청 초과 — 잠시 후 갱신해주세요.')
  );
}

// ── 종목별 시황 분석 — 캔들·지표 컨텍스트 + 웹 검색으로 심층 리포트(구독 경로 전용) ──

export interface SymbolAnalysisContext {
  symbol: string;
  currentPrice?: number;
  /** 일봉(최근 → 과거 정렬 무관, 최대 40개 권장) — 중기 추세 판단용. */
  daily: AiDecisionCandle[];
  /** 5분봉(최대 60개) — 당일 흐름 판단용. */
  intraday: AiDecisionCandle[];
  signal?: { level: string; score: number; rsi?: number; sma20?: number; sma50?: number; atr?: number };
  regime?: { adx?: number; state: string };
}

export interface AiSymbolAnalysis {
  stance: 'bullish' | 'bearish' | 'neutral';
  trend: string;
  drivers: string[];
  support?: string;
  resistance?: string;
  scenario: string;
  risks: string;
  model: string;
  fallback?: boolean;
}

const ANALYSIS_TIMEOUT_MS = 150_000;
const ANALYSIS_HARD_TIMEOUT_MS = ANALYSIS_TIMEOUT_MS + 15_000;

const ANALYSIS_SYSTEM = `너는 미국 주식 시황 분석가다. 제공된 캔들·지표 데이터(기술적)와
WebSearch 로 확인한 최신 뉴스·수급·섹터 동향(재료)을 종합해 한국어 시황 리포트를 작성한다.
규칙:
- 기술적 판단은 제공된 데이터에 근거하고, 뉴스·재료는 검색으로 확인한 것만 쓴다.
- 지지/저항은 캔들에서 근거 있는 구체적 가격대로 제시한다.
- 단정 대신 조건부 시나리오("~를 지키면/이탈하면")로 서술한다. 투자 권유 금지.
- 분량: trend 2~3문장, drivers 2~4개(각 한 줄), scenario 2~3문장, risks 1~2문장.`;

const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['stance', 'trend', 'drivers', 'scenario', 'risks'],
  properties: {
    stance: { type: 'string', enum: ['bullish', 'bearish', 'neutral'], description: '종합 스탠스' },
    trend: { type: 'string', description: '추세 요약(중기+당일)' },
    drivers: { type: 'array', items: { type: 'string' }, description: '주요 동인(뉴스·수급·섹터)' },
    support: { type: 'string', description: '주요 지지선(가격대·근거 한 줄)' },
    resistance: { type: 'string', description: '주요 저항선(가격대·근거 한 줄)' },
    scenario: { type: 'string', description: '단기 시나리오(조건부)' },
    risks: { type: 'string', description: '핵심 리스크' },
  },
} as const;

function fmtCandleLine(c: AiDecisionCandle): string {
  const d = new Date(c.t * 1000).toISOString().slice(0, 16).replace('T', ' ');
  return `${d} O${c.o} H${c.h} L${c.l} C${c.c} V${c.v}`;
}

function buildAnalysisPrompt(ctx: SymbolAnalysisContext): string {
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const lines = [
    `오늘(KST): ${today}`,
    `종목: ${ctx.symbol}`,
    ctx.currentPrice ? `현재가: $${ctx.currentPrice}` : '',
    ctx.signal
      ? `지표(5분봉): score ${ctx.signal.score} (${ctx.signal.level})` +
        (ctx.signal.rsi !== undefined ? ` · RSI ${ctx.signal.rsi.toFixed(1)}` : '') +
        (ctx.signal.sma20 !== undefined ? ` · SMA20 ${ctx.signal.sma20.toFixed(2)}` : '') +
        (ctx.signal.sma50 !== undefined ? ` · SMA50 ${ctx.signal.sma50.toFixed(2)}` : '')
      : '',
    ctx.regime ? `국면: ${ctx.regime.state}${ctx.regime.adx !== undefined ? ` (ADX ${ctx.regime.adx.toFixed(1)})` : ''}` : '',
    '',
    `일봉(${ctx.daily.length}개):`,
    ...ctx.daily.map(fmtCandleLine),
    '',
    `5분봉(${ctx.intraday.length}개):`,
    ...ctx.intraday.map(fmtCandleLine),
    '',
    '위 데이터로 기술적 흐름을 분석하고, WebSearch 로 이 종목의 최신 뉴스·수급·섹터 동향을 확인해',
    '시황 리포트를 JSON 으로 작성해줘.',
  ];
  return lines.filter((l) => l !== '').join('\n');
}

function symbolAnalysisFallback(reason: string): AiSymbolAnalysis {
  return { stance: 'neutral', trend: reason, drivers: [], scenario: '', risks: '', model: 'fallback', fallback: true };
}

function normalizeSymbolAnalysis(parsed: Record<string, unknown>): AiSymbolAnalysis {
  const stance =
    parsed.stance === 'bullish' || parsed.stance === 'bearish' || parsed.stance === 'neutral'
      ? parsed.stance
      : 'neutral';
  const drivers = Array.isArray(parsed.drivers)
    ? parsed.drivers.filter((d): d is string => typeof d === 'string').map((d) => d.slice(0, 300)).slice(0, 6)
    : [];
  return {
    stance,
    trend: typeof parsed.trend === 'string' ? parsed.trend.slice(0, 800) : '',
    drivers,
    support: typeof parsed.support === 'string' ? parsed.support.slice(0, 200) : undefined,
    resistance: typeof parsed.resistance === 'string' ? parsed.resistance.slice(0, 200) : undefined,
    scenario: typeof parsed.scenario === 'string' ? parsed.scenario.slice(0, 800) : '',
    risks: typeof parsed.risks === 'string' ? parsed.risks.slice(0, 500) : '',
    model: MODEL,
  };
}

async function analyzeSymbolViaSubscription(ctx: SymbolAnalysisContext): Promise<AiSymbolAnalysis> {
  const { query } = await loadAgentSdk();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ANALYSIS_TIMEOUT_MS);
  try {
    const stream = query({
      prompt: buildAnalysisPrompt(ctx),
      options: {
        model: MODEL,
        systemPrompt: ANALYSIS_SYSTEM,
        maxTurns: 15,
        tools: ['WebSearch'],
        allowedTools: ['WebSearch'],
        permissionMode: 'dontAsk',
        settingSources: [],
        persistSession: false,
        outputFormat: {
          type: 'json_schema',
          schema: ANALYSIS_SCHEMA as unknown as Record<string, unknown>,
        },
        abortController: abort,
      },
    });

    for await (const message of stream) {
      if (message.type !== 'result') continue;
      if (message.subtype !== 'success') {
        const detail = message.errors?.length ? message.errors.join('; ') : message.subtype;
        return symbolAnalysisFallback(`AI 분석 실패(${detail}) — 다시 시도해주세요.`);
      }
      let raw: unknown = message.structured_output;
      if (raw === undefined && typeof message.result === 'string') {
        try {
          raw = JSON.parse(message.result);
        } catch {
          return symbolAnalysisFallback('AI 응답 파싱 실패 — 다시 시도해주세요.');
        }
      }
      if (!raw || typeof raw !== 'object') {
        return symbolAnalysisFallback('AI 응답 없음 — 다시 시도해주세요.');
      }
      return normalizeSymbolAnalysis(raw as Record<string, unknown>);
    }
    return symbolAnalysisFallback('AI 응답 없음 — 다시 시도해주세요.');
  } catch (error) {
    const message = abort.signal.aborted
      ? `시간 초과(${ANALYSIS_TIMEOUT_MS / 1000}s)`
      : error instanceof Error
        ? error.message
        : '알 수 없는 오류';
    return symbolAnalysisFallback(`AI 분석 실패: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

function analyzeSymbolWithHardTimeout(ctx: SymbolAnalysisContext): Promise<AiSymbolAnalysis> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.error('[ai] 시황 분석 무응답 — 하드 타임아웃: 런타임 정리 후 슬롯 회수');
      killStaleClaudeRuntimes(() => resolve(symbolAnalysisFallback('AI 분석 무응답(하드 타임아웃)')));
    }, ANALYSIS_HARD_TIMEOUT_MS);
    analyzeSymbolViaSubscription(ctx).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        resolve(
          symbolAnalysisFallback(`AI 분석 실패: ${error instanceof Error ? error.message : '오류'}`)
        );
      }
    );
  });
}

export async function getAiSymbolAnalysis(ctx: SymbolAnalysisContext): Promise<AiSymbolAnalysis> {
  if (!isAiConfigured()) return symbolAnalysisFallback('AI 미설정(CLAUDE_CODE_OAUTH_TOKEN 없음)');
  if (getAiAuthMode() !== 'subscription') {
    return symbolAnalysisFallback('시황 분석(웹 검색)은 구독(OAuth) 모드에서만 지원합니다.');
  }
  return queueSubscriptionTask(
    () => analyzeSymbolWithHardTimeout(ctx),
    () => symbolAnalysisFallback('AI 동시 요청 초과 — 잠시 후 다시 시도해주세요.')
  );
}

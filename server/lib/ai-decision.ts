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
  /** 직전 AI 판단 이력(최근→과거). 일관성 있는 연속 판단을 위해 제공. */
  history?: {
    t: number; // epoch ms
    action: string;
    confidence?: number;
    executed?: boolean;
    reason?: string;
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
- 추세 전환 '초입'(반등/눌림 확인 1~2봉 + 거래량·호가 우위 동반)에는 소량(sizePct 낮게) 진입을
  제안하세요. 확신이 쌓이면 sizePct 를 키워 표현합니다(상한은 앱이 캡). 확신 낮음 = 소량이지
  HOLD 가 아닙니다.
- 손절·한도·쿨다운·킬스위치 같은 안전장치는 앱이 코드로 강제합니다. 방향 제안을 지나치게 망설일
  필요가 없습니다 — 틀리면 손절이 지켜줍니다.
- 다만 두 가지는 피합니다: 급등 마지막 봉 고점 추격, 그리고 직전 판단의 무근거 뒤집기.
  직전 판단을 뒤집을 때는 새 근거(추세 전환·급변)를 reason 에 명시하세요.
- 보유 중 목표 수익률/손절률 부근이거나 추세가 꺾이면 청산(SELL) 제안을 주저하지 않습니다.
- 같은 방향의 미체결 주문이 이미 있으면 중복 진입(BUY)·중복 청산(SELL)을 제안하지 않습니다.
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
      ? `직전 판단(최근→과거): ${req.history
          .slice(0, 8)
          .map(
            (h) =>
              `${h.action}${h.confidence !== undefined ? `(${(h.confidence * 100).toFixed(0)}%)` : ''}${h.executed ? '·실행됨' : ''}`
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

function queueSubscriptionDecision(req: AiDecisionRequest): Promise<AiDecision> {
  if (pendingSubscriptionCalls >= MAX_PENDING_SUBSCRIPTION_CALLS) {
    console.error(`[ai] 구독 대기열 초과(pending=${pendingSubscriptionCalls}) — 보류 폴백`);
    return Promise.resolve(holdFallback('AI 판단 동시 요청 초과 — 보류'));
  }
  pendingSubscriptionCalls += 1;
  const run = () => runWithHardTimeout(req);
  const result = subscriptionChain.then(run, run).finally(() => {
    pendingSubscriptionCalls -= 1;
  });
  subscriptionChain = result.catch(() => undefined);
  return result;
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

import Anthropic from '@anthropic-ai/sdk';

/**
 * LLM(Claude) 실시간 매매 판단.
 *
 * 안전 원칙:
 *  - 모델은 BUY/SELL/HOLD '제안'만 한다. 손절·1회 한도·쿨다운·킬스위치·탭가시성 등
 *    하드 가드는 클라이언트(코드)에서 강제하며, 모델이 이를 우회할 수 없다.
 *  - 거부(refusal)·오류·미설정 등 어떤 실패든 fail-safe = HOLD(아무것도 안 함)로 폴백.
 *  - API 키는 서버 .env(ANTHROPIC_API_KEY)에만 둔다. 클라이언트로 노출하지 않는다.
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
  orderbook?: { bestBid?: number; bestAsk?: number; bidRatio?: number };
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

const SYSTEM_PROMPT = `당신은 미국 주식 단기 매매를 보조하는 신중한 트레이딩 판단 엔진입니다.
입력으로 한 종목의 최근 '완성된' 캔들(OHLCV)·지표·추세·호가·보유 상태를 받습니다.
음봉/양봉 추세, 모멘텀(RSI), 이동평균 배열, 거래량, 변동성(ATR), 호가 균형을 종합해
"지금 이 봉 마감 시점"에 취할 행동을 BUY / SELL / HOLD 중 하나로 제안합니다.

원칙:
- 보수적으로 판단합니다. 근거가 모호하면 HOLD 가 기본입니다. 추세가 명확히 위로 확정될 때만 BUY,
  명확히 꺾이거나 청산이 합리적일 때만 SELL.
- 손절·한도·쿨다운·킬스위치 같은 안전장치는 앱이 코드로 강제합니다. 당신은 그 안에서 '방향'만 제안하면 됩니다.
- 과최적화·추격매수·잦은 뒤집기를 피합니다. 같은 추세 안에서는 일관된 판단을 유지하세요.
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

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) return null;
  if (!client) client = new Anthropic();
  return client;
}

export function isAiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
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
    '',
    `최근 완성봉(오래된→최근, 최대 ${MAX_CANDLES}개):`,
    candleLines || '(캔들 없음)',
    '',
    '지금 봉 마감 시점의 행동을 스키마에 맞춰 제안하세요.',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function getAiTradeDecision(req: AiDecisionRequest): Promise<AiDecision> {
  const anthropic = getClient();
  if (!anthropic) {
    return holdFallback('AI 미설정(ANTHROPIC_API_KEY 없음) — 자동 판단 비활성', 'unconfigured');
  }
  if (!req.currentPrice || !Number.isFinite(req.currentPrice) || !(req.candles?.length)) {
    return holdFallback('입력 데이터 부족 — 판단 보류');
  }

  try {
    const response = await anthropic.messages.create({
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

    let parsed: { action?: string; sizePct?: number; confidence?: number; reason?: string };
    try {
      parsed = JSON.parse(textBlock.text);
    } catch {
      return holdFallback('AI 응답 파싱 실패 — 보류');
    }

    const action: AiAction =
      parsed.action === 'BUY' || parsed.action === 'SELL' ? parsed.action : 'HOLD';

    return {
      action,
      sizePct: clampNumber(parsed.sizePct, 0, 100, 0),
      confidence: clampNumber(parsed.confidence, 0, 1, 0),
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 300) : '',
      model: response.model ?? MODEL,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '알 수 없는 오류';
    return holdFallback(`AI 호출 실패: ${message} — 보류`);
  }
}

export type MicrostructureBias = 'bullish' | 'bearish' | 'neutral';

export interface OrderbookLevel {
  price: number;
  quantity: number;
}

export interface TradeTick {
  price: number;
  quantity: number;
  timestamp: string;
}

export interface SpreadSnapshot {
  bestBid?: number;
  bestAsk?: number;
  spread?: number;
  spreadPercent?: number;
  label: string;
  value: string;
  bias: MicrostructureBias;
}

export interface TradeFlowSnapshot {
  buyVolume: number;
  sellVolume: number;
  buyRatio: number;
  label: string;
  value: string;
  bias: MicrostructureBias;
}

function getBestBid(bids: OrderbookLevel[]) {
  if (bids.length === 0) return undefined;
  return Math.max(...bids.map((bid) => bid.price));
}

function getBestAsk(asks: OrderbookLevel[]) {
  if (asks.length === 0) return undefined;
  return Math.min(...asks.map((ask) => ask.price));
}

function formatUsd(value: number) {
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })}`;
}

export function buildSpreadSnapshot(
  bids: OrderbookLevel[],
  asks: OrderbookLevel[]
): SpreadSnapshot {
  const bestBid = getBestBid(bids);
  const bestAsk = getBestAsk(asks);

  if (bestBid === undefined || bestAsk === undefined || bestAsk <= bestBid || bestBid <= 0) {
    return { label: '스프레드', value: '—', bias: 'neutral' };
  }

  const spread = bestAsk - bestBid;
  const mid = (bestAsk + bestBid) / 2;
  const spreadPercent = mid > 0 ? (spread / mid) * 100 : undefined;

  let bias: MicrostructureBias = 'neutral';
  if (spreadPercent !== undefined) {
    if (spreadPercent < 0.05) bias = 'bullish';
    else if (spreadPercent > 0.15) bias = 'bearish';
  }

  const percentText = spreadPercent !== undefined ? ` (${spreadPercent.toFixed(3)}%)` : '';

  return {
    bestBid,
    bestAsk,
    spread,
    spreadPercent,
    label: '스프레드',
    value: `${formatUsd(spread)}${percentText}`,
    bias,
  };
}

function inferTradeSide(
  price: number,
  previousPrice: number | undefined,
  previousSide: 'buy' | 'sell' | undefined,
  mid?: number
): 'buy' | 'sell' | undefined {
  if (previousPrice !== undefined) {
    if (price > previousPrice) return 'buy';
    if (price < previousPrice) return 'sell';
    return previousSide;
  }

  if (mid === undefined) return undefined;
  return price >= mid ? 'buy' : 'sell';
}

export function buildTradeFlowSnapshot(
  trades: TradeTick[],
  bids: OrderbookLevel[],
  asks: OrderbookLevel[]
): TradeFlowSnapshot {
  if (trades.length === 0) {
    return {
      buyVolume: 0,
      sellVolume: 0,
      buyRatio: 0.5,
      label: '체결 흐름',
      value: '—',
      bias: 'neutral',
    };
  }

  const bestBid = getBestBid(bids);
  const bestAsk = getBestAsk(asks);
  const mid = bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : undefined;

  const sorted = [...trades].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  let buyVolume = 0;
  let sellVolume = 0;
  let previousPrice: number | undefined;
  let previousSide: 'buy' | 'sell' | undefined;

  for (const trade of sorted) {
    const side = inferTradeSide(trade.price, previousPrice, previousSide, mid);

    if (side === 'buy') {
      buyVolume += trade.quantity;
      previousSide = 'buy';
    } else if (side === 'sell') {
      sellVolume += trade.quantity;
      previousSide = 'sell';
    }

    previousPrice = trade.price;
  }

  const total = buyVolume + sellVolume;
  const buyRatio = total > 0 ? buyVolume / total : 0.5;
  const buyPercent = Math.round(buyRatio * 100);

  let bias: MicrostructureBias = 'neutral';
  if (buyRatio >= 0.6) bias = 'bullish';
  else if (buyRatio <= 0.4) bias = 'bearish';

  return {
    buyVolume,
    sellVolume,
    buyRatio,
    label: '체결 흐름',
    value: `매수 ${buyPercent}% · ${buyVolume.toLocaleString()}/${sellVolume.toLocaleString()}`,
    bias,
  };
}

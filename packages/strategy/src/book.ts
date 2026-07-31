import { ONE, prob, type BookLevel, type Prob6, type Shares6 } from "@b5p/domain";

/**
 * L2 order book state for one outcome token, maintained from CLOB WS
 * snapshots and price_change level updates.
 */
export class BookState {
  bids = new Map<bigint, bigint>(); // price6 -> size6
  asks = new Map<bigint, bigint>();
  sourceTsMs = 0;
  receivedTsMs = 0;
  lastTradePrice6: Prob6 | null = null;
  lastTradeTsMs: number | null = null;
  private flipCount = 0;
  private lastBest: { bid: bigint | null; ask: bigint | null } = { bid: null, ask: null };

  constructor(public readonly tokenId: string) {}

  applySnapshot(bids: Array<{ price: string; size: string }>, asks: Array<{ price: string; size: string }>, sourceTsMs: number, receivedTsMs: number): void {
    this.bids.clear();
    this.asks.clear();
    for (const l of bids) this.bids.set(prob(l.price), parseSize(l.size));
    for (const l of asks) this.asks.set(prob(l.price), parseSize(l.size));
    this.sourceTsMs = sourceTsMs;
    this.receivedTsMs = receivedTsMs;
    this.trackFlip();
  }

  /** price_change events carry the NEW size at a level (0 removes it) for a given side. */
  applyLevelUpdate(price: string, size: string, side: "BUY" | "SELL", sourceTsMs: number, receivedTsMs: number): void {
    const p = prob(price);
    const s = parseSize(size);
    const book = side === "BUY" ? this.bids : this.asks;
    if (s === 0n) book.delete(p);
    else book.set(p, s);
    this.sourceTsMs = sourceTsMs;
    this.receivedTsMs = receivedTsMs;
    this.trackFlip();
  }

  applyTrade(price: string, sourceTsMs: number): void {
    this.lastTradePrice6 = prob(price);
    this.lastTradeTsMs = sourceTsMs;
  }

  private trackFlip(): void {
    const bid = this.bestBid();
    const ask = this.bestAsk();
    if (this.lastBest.bid !== null && (bid !== this.lastBest.bid || ask !== this.lastBest.ask)) this.flipCount++;
    this.lastBest = { bid, ask };
  }

  bestBid(): Prob6 | null {
    let best: bigint | null = null;
    for (const [p, s] of this.bids) if (s > 0n && (best === null || p > best)) best = p;
    return best;
  }

  bestAsk(): Prob6 | null {
    let best: bigint | null = null;
    for (const [p, s] of this.asks) if (s > 0n && (best === null || p < best)) best = p;
    return best;
  }

  spread(): Prob6 | null {
    const b = this.bestBid();
    const a = this.bestAsk();
    return b !== null && a !== null ? a - b : null;
  }

  mid(): Prob6 | null {
    const b = this.bestBid();
    const a = this.bestAsk();
    return b !== null && a !== null ? (a + b) / 2n : null;
  }

  sortedBids(): BookLevel[] {
    return [...this.bids.entries()].filter(([, s]) => s > 0n).sort((a, b) => (a[0] > b[0] ? -1 : 1)).map(([price, size]) => ({ price, size }));
  }

  sortedAsks(): BookLevel[] {
    return [...this.asks.entries()].filter(([, s]) => s > 0n).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([price, size]) => ({ price, size }));
  }

  depthTopN(side: "bid" | "ask", n: number): Shares6 {
    const levels = side === "bid" ? this.sortedBids() : this.sortedAsks();
    return levels.slice(0, n).reduce((s, l) => s + l.size, 0n);
  }

  /** Microprice = (bestAsk*bidSize + bestBid*askSize) / (bidSize + askSize), as float prob. */
  microprice(): number | null {
    const bids = this.sortedBids();
    const asks = this.sortedAsks();
    if (bids.length === 0 || asks.length === 0) return null;
    const bb = bids[0]!;
    const ba = asks[0]!;
    const den = Number(bb.size + ba.size);
    if (den === 0) return null;
    return (Number(ba.price) * Number(bb.size) + Number(bb.price) * Number(ba.size)) / den / Number(ONE);
  }

  /** Imbalance in [-1,1] at top-N depth: (bid - ask) / (bid + ask). */
  imbalance(n = 5): number | null {
    const b = Number(this.depthTopN("bid", n));
    const a = Number(this.depthTopN("ask", n));
    if (b + a === 0) return null;
    return (b - a) / (b + a);
  }

  /** Slope: how much price must move to absorb top-N size, per side (float prob per share). */
  slope(n = 5): number | null {
    const asks = this.sortedAsks().slice(0, n);
    if (asks.length < 2) return null;
    const dp = Number(asks[asks.length - 1]!.price - asks[0]!.price) / Number(ONE);
    const size = Number(asks.reduce((s, l) => s + l.size, 0n)) / Number(ONE);
    return size > 0 ? dp / size : null;
  }

  /**
   * Average execution price and impact for a taker buy of `size` shares walking the asks.
   * Returns null if the book cannot fill the size.
   */
  takerBuyImpact(size: Shares6): { avgPrice6: Prob6; worstPrice6: Prob6; impact6: Prob6 } | null {
    const asks = this.sortedAsks();
    if (asks.length === 0 || size <= 0n) return null;
    let remaining = size;
    let cost = 0n; // price6 * shares6 accumulated (scale 1e12)
    let worst = asks[0]!.price;
    for (const l of asks) {
      const take = remaining < l.size ? remaining : l.size;
      cost += l.price * take;
      worst = l.price;
      remaining -= take;
      if (remaining === 0n) break;
    }
    if (remaining > 0n) return null;
    const avg = cost / size;
    return { avgPrice6: avg, worstPrice6: worst, impact6: avg - asks[0]!.price };
  }

  /** Displayed size resting at a price level on the bid side (queue ahead for a hypothetical joining maker). */
  queueAtBid(price: Prob6): Shares6 {
    return this.bids.get(price) ?? 0n;
  }

  get quoteFlipCount(): number { return this.flipCount; }

  ageMs(nowMs: number): number | null {
    return this.receivedTsMs === 0 ? null : nowMs - this.receivedTsMs;
  }
}

function parseSize(s: string): Shares6 {
  // sizes arrive as decimal share counts, e.g. "33343.4"
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`bad size: ${s}`);
  const frac = (m[2] ?? "").slice(0, 6).padEnd(6, "0");
  return BigInt(m[1]!) * 1_000_000n + BigInt(frac || "0");
}

/** Complementary-price consistency: UP bid + DOWN ask should be ~1. Returns |1 - (upBid + downAsk)| as prob float. */
export function complementConsistency(up: BookState, down: BookState): number | null {
  const ub = up.bestBid();
  const da = down.bestAsk();
  if (ub === null || da === null) return null;
  return Math.abs(1 - Number(ub + da) / Number(ONE));
}

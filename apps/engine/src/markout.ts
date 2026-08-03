import {
  type MarkoutHorizon, type OrderSide, type OutcomeSide, type Prob6, type Shares6,
} from "@b5p/domain";
import { newId } from "@b5p/domain/ids";
import type { BookState } from "@b5p/strategy";
import {
  COUNTERFACTUAL_MAX_EVIDENCE, COUNTERFACTUAL_MAX_WATCHES, MARKOUT_BOOK_GRACE_MS,
} from "./execution-constants";
import type { ExecutionPersistence } from "./execution-persistence";

/**
 * Post-fill markout sampler (plan item 1b §3).
 *
 * After any fill (paper or live) the book mid is sampled at the configured
 * horizons plus at resolution. markout6 is side-adjusted: positive = the
 * market moved in our favor after we filled (we were NOT adversely selected).
 *
 * Invariant: an observation is only ever taken from a book whose data is
 * STRICTLY NEWER than the fill timestamp. If no such book arrives within
 * horizon + grace the observation is dropped (never fabricated) — the schema
 * requires a real midAtHorizon6.
 */

export interface RegisteredFill {
  correlationId: string;
  attemptId: string | null;
  fillId: string | null;
  marketId: string;
  tokenId: string;
  side: OrderSide;
  fillTsMs: number;
  /** Book mid at fill time (falls back to fill price when the book was unusable). */
  midAtFill6: Prob6;
}

interface PendingMarkout {
  fill: RegisteredFill;
  horizonMs: number;
  dueMs: number;
}

export class MarkoutSampler {
  private pending: PendingMarkout[] = [];
  private byMarket = new Map<string, RegisteredFill[]>();

  constructor(
    private readonly persistence: ExecutionPersistence,
    private readonly books: (tokenId: string) => BookState | null,
    private readonly horizonsMs: () => readonly number[],
    private readonly configVersion: () => number,
  ) {}

  registerFill(f: RegisteredFill): void {
    for (const h of this.horizonsMs()) {
      this.pending.push({ fill: f, horizonMs: h, dueMs: f.fillTsMs + h });
    }
    const list = this.byMarket.get(f.marketId) ?? [];
    list.push(f);
    this.byMarket.set(f.marketId, list);
  }

  pendingCount(): number {
    return this.pending.length;
  }

  /** Sample all due horizons. Books older than the fill are never used. */
  sample(nowMs: number): number {
    if (this.pending.length === 0) return 0;
    let emitted = 0;
    const keep: PendingMarkout[] = [];
    for (const p of this.pending) {
      if (nowMs < p.dueMs) { keep.push(p); continue; }
      if (nowMs - p.dueMs > MARKOUT_BOOK_GRACE_MS) continue; // too late to attribute: drop, never fabricate
      const book = this.books(p.fill.tokenId);
      const mid = book?.mid() ?? null;
      const bookFresh = book !== null && book.receivedTsMs > p.fill.fillTsMs;
      if (!bookFresh || mid === null) {
        keep.push(p); // book may still catch up within the grace window
        continue;
      }
      this.persistence.addMarkout({
        id: newId(),
        correlationId: p.fill.correlationId,
        attemptId: p.fill.attemptId,
        fillId: p.fill.fillId,
        marketId: p.fill.marketId,
        tokenId: p.fill.tokenId,
        side: p.fill.side,
        horizonMs: p.horizonMs as MarkoutHorizon, // persisted as text; configured horizons only
        midAtFill6: p.fill.midAtFill6,
        midAtHorizon6: mid,
        markout6: p.fill.side === "BUY" ? mid - p.fill.midAtFill6 : p.fill.midAtFill6 - mid,
        tsMs: nowMs,
        configVersion: this.configVersion(),
      });
      emitted++;
    }
    this.pending = keep;
    return emitted;
  }

  /** AT_RESOLUTION markout: settle value per share (1.0 for the winning side, else 0). */
  onResolution(marketId: string, outcome: OutcomeSide, sideOf: (tokenId: string) => OutcomeSide | null, nowMs: number): number {
    const fills = this.byMarket.get(marketId);
    if (!fills) return 0;
    this.byMarket.delete(marketId);
    let emitted = 0;
    for (const f of fills) {
      const outcomeSide = sideOf(f.tokenId);
      if (outcomeSide === null) continue;
      const settle6: Prob6 = outcomeSide === outcome ? 1_000_000n : 0n;
      this.persistence.addMarkout({
        id: newId(),
        correlationId: f.correlationId,
        attemptId: f.attemptId,
        fillId: f.fillId,
        marketId: f.marketId,
        tokenId: f.tokenId,
        side: f.side,
        horizonMs: "AT_RESOLUTION",
        midAtFill6: f.midAtFill6,
        midAtHorizon6: settle6,
        markout6: f.side === "BUY" ? settle6 - f.midAtFill6 : f.midAtFill6 - settle6,
        tsMs: nowMs,
        configVersion: this.configVersion(),
      });
      emitted++;
    }
    // resolution also invalidates any still-pending horizon samples for the market
    this.pending = this.pending.filter((p) => p.fill.marketId !== marketId);
    return emitted;
  }
}

/**
 * Fill-counterfactual recorder: tracks would-be maker fills that did NOT
 * happen — an order we never placed (shadow / risk-rejected) or one that did
 * not rest long enough (canceled with remaining size) — using the same
 * conservative queue model as the paper executor, with the trade tape as
 * evidence.
 */

export interface CounterfactualWatch {
  id: string;
  correlationId: string;
  decisionId: string;
  marketId: string;
  tokenId: string;
  price6: Prob6;
  size6: Shares6;
  reason: string; // shadow_not_placed | risk_rejected | canceled_before_fill | post_only_rejected
  queueAhead6: Shares6;
  filled6: Shares6;
  registeredAtMs: number;
  expiresAtMs: number;
  evidence: Array<{ price6: string; size6: string; consumedQueue6: string; filled6: string; tsMs: number }>;
}

export class FillCounterfactualRecorder {
  private watches: CounterfactualWatch[] = [];

  constructor(
    private readonly persistence: ExecutionPersistence,
    private readonly configVersion: () => number,
    private readonly enabled: () => boolean,
  ) {}

  register(args: Omit<CounterfactualWatch, "id" | "filled6" | "evidence">): void {
    if (!this.enabled() || args.size6 <= 0n) return;
    if (this.watches.length >= COUNTERFACTUAL_MAX_WATCHES) this.watches.shift();
    this.watches.push({ ...args, id: newId(), filled6: 0n, evidence: [] });
  }

  watchCount(): number {
    return this.watches.length;
  }

  /** Feed printed trades; a resting BUY at P would be hit by prints at P or lower. */
  onTrade(tokenId: string, price6: Prob6, size6: Shares6, tsMs: number): void {
    for (const w of this.watches) {
      if (w.tokenId !== tokenId) continue;
      if (tsMs < w.registeredAtMs || tsMs >= w.expiresAtMs) continue;
      if (w.filled6 >= w.size6) continue;
      if (price6 > w.price6) continue;
      let tradable = size6;
      let consumed = 0n;
      if (w.queueAhead6 > 0n) {
        consumed = tradable < w.queueAhead6 ? tradable : w.queueAhead6;
        w.queueAhead6 -= consumed;
        tradable -= consumed;
      }
      const remaining = w.size6 - w.filled6;
      const fill = tradable < remaining ? tradable : remaining;
      if (fill > 0n) w.filled6 += fill;
      if ((fill > 0n || consumed > 0n) && w.evidence.length < COUNTERFACTUAL_MAX_EVIDENCE) {
        w.evidence.push({
          price6: price6.toString(), size6: size6.toString(),
          consumedQueue6: consumed.toString(), filled6: fill.toString(), tsMs,
        });
      }
    }
  }

  /** Persist and remove watches that expired or fully filled. */
  expire(nowMs: number): number {
    let flushed = 0;
    const keep: CounterfactualWatch[] = [];
    for (const w of this.watches) {
      if (nowMs < w.expiresAtMs && w.filled6 < w.size6) { keep.push(w); continue; }
      this.persistence.addCounterfactual({
        id: w.id,
        correlationId: w.correlationId,
        decisionId: w.decisionId,
        marketId: w.marketId,
        tokenId: w.tokenId,
        price6: w.price6,
        size6: w.size6,
        wouldFill: w.filled6 > 0n,
        reason: w.reason,
        evidence: {
          wouldFillShares6: w.filled6.toString(),
          queueAheadAtRegistration6: (w.queueAhead6 + sumConsumed(w)).toString(),
          registeredAtMs: w.registeredAtMs,
          trades: w.evidence,
        },
        tsMs: nowMs,
        configVersion: this.configVersion(),
      });
      flushed++;
    }
    this.watches = keep;
    return flushed;
  }
}

function sumConsumed(w: CounterfactualWatch): bigint {
  return w.evidence.reduce((s, e) => s + BigInt(e.consumedQueue6), 0n);
}

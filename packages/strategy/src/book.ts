import { createHash } from "node:crypto";
import { ONE, prob, type BookLevel, type Prob6, type Shares6 } from "@b5p/domain";

/**
 * Continuity/integrity evidence level of a book (spec §10.3 / §12.1).
 *
 * Fail-closed notes:
 * - `SEQUENCED_CONTIGUOUS` and `HASH_CHAIN_VERIFIED` are representable but NO
 *   code path in this layer produces them: the Polymarket market channel
 *   supplies neither a documented monotonic sequence contract nor an
 *   officially documented hash-chain algorithm (§12.4). Continuity evidence is
 *   never overstated.
 * - The initial state is `INVALID_AFTER_RECONNECT`: before the first full
 *   snapshot of the current connection epoch a book is never usable.
 */
export type BookIntegrity =
  | "VERIFIED_SNAPSHOT"
  | "SEQUENCED_CONTIGUOUS"
  | "HASH_CHAIN_VERIFIED"
  | "UNSEQUENCED_AFTER_SNAPSHOT"
  | "INVALID_AFTER_RECONNECT"
  | "GAP_SUSPECTED";

/** Integrity levels eligible for pair PAPER scheduling (§12.1). */
export function isPaperEligibleIntegrity(i: BookIntegrity): boolean {
  return i === "VERIFIED_SNAPSHOT" || i === "SEQUENCED_CONTIGUOUS" || i === "HASH_CHAIN_VERIFIED";
}

/** Integrity levels eligible for OBSERVER economic evaluation (§12.1: paper set plus unsequenced-after-snapshot). */
export function isObserverEligibleIntegrity(i: BookIntegrity): boolean {
  return isPaperEligibleIntegrity(i) || i === "UNSEQUENCED_AFTER_SNAPSHOT";
}

/** Immutable deep book snapshot (spec §10.3, normative shape). */
export interface ImmutableBookView {
  readonly tokenId: string;
  readonly marketId: string;
  readonly bookVersion: bigint;
  readonly connectionEpoch: string;
  readonly bids: readonly Readonly<BookLevel>[];
  readonly asks: readonly Readonly<BookLevel>[];
  readonly sourceTsMs: number;
  readonly receivedTsMs: number;
  readonly exchangeHash: string | null;
  readonly sourceEventId: string;
  readonly integrity:
    | "VERIFIED_SNAPSHOT"
    | "SEQUENCED_CONTIGUOUS"
    | "HASH_CHAIN_VERIFIED"
    | "UNSEQUENCED_AFTER_SNAPSHOT"
    | "INVALID_AFTER_RECONNECT"
    | "GAP_SUSPECTED";
}

/** Provenance metadata attached to a full snapshot application. */
export interface BookSourceMeta {
  /** Epoch of the connection that delivered this message. */
  connectionEpoch?: string;
  /** Source event identifier when the feed supplies one; "" means none supplied. */
  sourceEventId?: string;
  /** Exchange-supplied book hash when present (provenance only, never verification — §12.4). */
  exchangeHash?: string | null;
  /** Market/condition id when known. */
  marketId?: string;
}

/** Provenance metadata for one price_change envelope. */
export interface BookEnvelopeMeta extends BookSourceMeta {
  /** Source sequence when the feed supplies one. Never invented locally (§12.5). */
  sourceSequence?: bigint | null;
}

/** One level change inside a price_change envelope (new size at level; 0 removes). */
export interface BookEnvelopeChange {
  price: string;
  size: string;
  side: "BUY" | "SELL";
}

/** Outcome of an atomic envelope application. Rejections leave levels untouched. */
export type EnvelopeApplyOutcome =
  | "APPLIED"
  /** Levels were applied for diagnostics but the book was already invalid; a delta never revives a book (§12.3). */
  | "APPLIED_WHILE_INVALID"
  /** Same sourceEventId and identical exchange hash: ignored but counted (§12.5). */
  | "DUPLICATE_IGNORED"
  /** Same sourceEventId with a DIFFERENT payload hash: feed unhealthy, book invalidated (§12.5). */
  | "REJECTED_DUPLICATE_PAYLOAD_MISMATCH"
  /** Envelope stamped with a different connection epoch than the book's current epoch. */
  | "REJECTED_EPOCH_MISMATCH"
  /** Source sequence regression: invalidated until a new snapshot (§12.5). */
  | "REJECTED_SEQUENCE_REGRESSION"
  /** Source timestamp regression beyond the configured tolerance (§12.5). */
  | "REJECTED_TIMESTAMP_REGRESSION";

/**
 * L2 order book state for one outcome token, maintained from CLOB WS
 * snapshots and price_change level updates.
 *
 * Integrity/epoch model (spec §12):
 * - `bookVersion` increments exactly once per accepted mutation (snapshot,
 *   envelope, legacy level update, invalidation). Trade telemetry
 *   (`applyTrade`) does not touch order-book content and does not bump it.
 * - `connectionEpoch` is "" until an epoch is established. A book that has
 *   been given a non-"" epoch is "epoch-aware": from then on only a full
 *   snapshot stamped with the SAME epoch restores validity (§12.3 barrier).
 * - Books start `INVALID_AFTER_RECONNECT` (fail closed; the initial connect
 *   is treated as the first reconnect with no snapshot yet).
 */
export class BookState {
  bids = new Map<bigint, bigint>(); // price6 -> size6
  asks = new Map<bigint, bigint>();
  sourceTsMs = 0;
  receivedTsMs = 0;
  lastTradePrice6: Prob6 | null = null;
  lastTradeTsMs: number | null = null;
  /** Market/condition id for provenance; settable directly or via snapshot meta. */
  marketId = "";
  /** Monotonic local version; +1 per mutation (one envelope = one increment). */
  bookVersion = 0n;
  /** Current connection epoch ("" = never told; legacy mode). */
  connectionEpoch = "";
  /** Continuity evidence, never overstated. Starts fail-closed. */
  integrity: BookIntegrity = "INVALID_AFTER_RECONNECT";
  /** Exchange-supplied hash of the LAST applied event (provenance only). */
  exchangeHash: string | null = null;
  /** Source event id of the LAST applied event; "" when the feed supplied none. */
  sourceEventId = "";
  /**
   * Tolerance for source-timestamp regressions without a sequence (§12.5).
   * null (default) = record only, never invalidate on timestamp alone.
   * When set, a regression strictly greater than this invalidates.
   */
  timestampRegressionToleranceMs: number | null = null;
  /** §12.5 counters: duplicates ignored, duplicate-id payload mismatches, sequence regressions, timestamp regressions. */
  duplicateIgnoredCount = 0;
  duplicatePayloadMismatchCount = 0;
  sequenceRegressionCount = 0;
  timestampRegressionCount = 0;
  private lastSourceSequence: bigint | null = null;
  private flipCount = 0;
  private lastBest: { bid: bigint | null; ask: bigint | null } = { bid: null, ask: null };

  constructor(public readonly tokenId: string, marketId = "") {
    this.marketId = marketId;
  }

  applySnapshot(bids: Array<{ price: string; size: string }>, asks: Array<{ price: string; size: string }>, sourceTsMs: number, receivedTsMs: number, meta?: BookSourceMeta): void {
    // Epoch gate (§12.3): once the book is epoch-aware, only a snapshot
    // stamped with the CURRENT epoch is "fresh". A stale snapshot from a
    // previous connection (old epoch, or no epoch at all) applies its levels
    // for diagnostics but does NOT restore validity.
    const epoch = meta?.connectionEpoch;
    const epochOk = this.connectionEpoch === "" ? true : epoch === this.connectionEpoch;
    this.bids.clear();
    this.asks.clear();
    for (const l of bids) this.bids.set(prob(l.price), parseSize(l.size));
    for (const l of asks) this.asks.set(prob(l.price), parseSize(l.size));
    this.sourceTsMs = sourceTsMs;
    this.receivedTsMs = receivedTsMs;
    if (meta?.marketId !== undefined) this.marketId = meta.marketId;
    this.exchangeHash = meta?.exchangeHash ?? null;
    this.sourceEventId = meta?.sourceEventId ?? "";
    this.lastSourceSequence = null; // full snapshot is a new continuity baseline
    if (epochOk) {
      if (epoch !== undefined) this.connectionEpoch = epoch; // adopt first epoch
      this.integrity = "VERIFIED_SNAPSHOT";
    } else {
      this.integrity = "INVALID_AFTER_RECONNECT";
    }
    this.bookVersion++;
    this.trackFlip();
  }

  /**
   * LEGACY per-level path: price_change events carry the NEW size at a level
   * (0 removes it) for a given side. This path applies ONE level per call, so
   * a multi-change envelope applied through it is observable in a torn state
   * between calls and leaves NO atomicity evidence (no envelope boundary, no
   * source metadata). Prefer {@link applyEnvelope} for pair evidence. Kept
   * as-is because the engine still calls it (characterization-pinned).
   */
  applyLevelUpdate(price: string, size: string, side: "BUY" | "SELL", sourceTsMs: number, receivedTsMs: number): void {
    const p = prob(price);
    const s = parseSize(size);
    const book = side === "BUY" ? this.bids : this.asks;
    if (s === 0n) book.delete(p);
    else book.set(p, s);
    this.sourceTsMs = sourceTsMs;
    this.receivedTsMs = receivedTsMs;
    // This path carries no source metadata; clear stale provenance honestly.
    this.exchangeHash = null;
    this.sourceEventId = "";
    this.bookVersion++;
    // An unsequenced delta demotes a verified book (§12.1); it never revives
    // an invalid one (§12.3).
    if (isPaperEligibleIntegrity(this.integrity)) this.integrity = "UNSEQUENCED_AFTER_SNAPSHOT";
    this.trackFlip();
  }

  /**
   * Atomic envelope application (§12.2): applies ALL level changes of one
   * price_change envelope as one unit — bookVersion increments ONCE and
   * timestamps are stamped ONCE, so no torn intermediate version is ever
   * observable. Duplicate/sequence/epoch/timestamp checks per §12.5 run
   * BEFORE any level is touched; every rejection leaves levels unchanged.
   */
  applyEnvelope(changes: readonly BookEnvelopeChange[], sourceTsMs: number, receivedTsMs: number, meta?: BookEnvelopeMeta): EnvelopeApplyOutcome {
    // 1. Epoch check: a delta stamped with a different epoch than the book's
    //    current epoch means a reset was missed — invalidate, do not apply.
    const epoch = meta?.connectionEpoch;
    if (this.connectionEpoch !== "" && epoch !== undefined && epoch !== this.connectionEpoch) {
      this.integrity = "INVALID_AFTER_RECONNECT";
      this.bookVersion++;
      return "REJECTED_EPOCH_MISMATCH";
    }
    // 2. Duplicate source event (§12.5): same id + identical hash → ignore but
    //    count; same id + different payload → feed unhealthy, invalidate.
    const eventId = meta?.sourceEventId ?? "";
    if (eventId !== "" && eventId === this.sourceEventId) {
      if ((meta?.exchangeHash ?? null) === this.exchangeHash) {
        this.duplicateIgnoredCount++;
        return "DUPLICATE_IGNORED";
      }
      this.duplicatePayloadMismatchCount++;
      this.integrity = "GAP_SUSPECTED";
      this.bookVersion++;
      return "REJECTED_DUPLICATE_PAYLOAD_MISMATCH";
    }
    // 3. Sequence regression (§12.5), only when the feed supplies sequences.
    const seq = meta?.sourceSequence ?? null;
    if (seq !== null && this.lastSourceSequence !== null && seq <= this.lastSourceSequence) {
      this.sequenceRegressionCount++;
      this.integrity = "GAP_SUSPECTED";
      this.bookVersion++;
      return "REJECTED_SEQUENCE_REGRESSION";
    }
    // 4. Timestamp regression without reordering (§12.5): local receive order
    //    stays the causal order; a regression is recorded, and invalidates
    //    only when it exceeds the configured tolerance.
    if (this.sourceTsMs > 0 && sourceTsMs < this.sourceTsMs) {
      this.timestampRegressionCount++;
      const tol = this.timestampRegressionToleranceMs;
      if (tol !== null && this.sourceTsMs - sourceTsMs > tol) {
        this.integrity = "GAP_SUSPECTED";
        this.bookVersion++;
        return "REJECTED_TIMESTAMP_REGRESSION";
      }
    }
    // 5. Apply every change as one unit.
    for (const c of changes) {
      const p = prob(c.price);
      const s = parseSize(c.size);
      const book = c.side === "BUY" ? this.bids : this.asks;
      if (s === 0n) book.delete(p);
      else book.set(p, s);
    }
    this.sourceTsMs = sourceTsMs;
    this.receivedTsMs = receivedTsMs;
    this.exchangeHash = meta?.exchangeHash ?? null;
    this.sourceEventId = eventId;
    if (seq !== null) this.lastSourceSequence = seq;
    this.bookVersion++;
    this.trackFlip();
    if (isPaperEligibleIntegrity(this.integrity)) {
      // Unsequenced delta demotes (§12.1); never upgraded by a local hash.
      this.integrity = "UNSEQUENCED_AFTER_SNAPSHOT";
      return "APPLIED";
    }
    if (this.integrity === "UNSEQUENCED_AFTER_SNAPSHOT") return "APPLIED";
    // INVALID_AFTER_RECONNECT / GAP_SUSPECTED: levels retained for
    // diagnostics only; a delta never revives the book (§12.3).
    return "APPLIED_WHILE_INVALID";
  }

  /**
   * Reconnect barrier (§12.3): called on connection epoch change. Marks the
   * book INVALID_AFTER_RECONNECT and records the new epoch. Old levels are
   * retained for diagnostics only. Only a fresh full snapshot stamped with
   * this NEW epoch restores validity; deltas never do.
   */
  invalidateForReconnect(newEpoch: string): void {
    this.connectionEpoch = newEpoch;
    this.integrity = "INVALID_AFTER_RECONNECT";
    this.lastSourceSequence = null;
    this.bookVersion++;
  }

  /**
   * Immutable deep snapshot (§10.3): deep-copied sorted positive levels,
   * recursively frozen, with all provenance fields. Later mutations of this
   * live book cannot alter a previously taken view. Compute the canonical
   * content hash with {@link canonicalBookHash}.
   */
  snapshot(): ImmutableBookView {
    const bids = Object.freeze(this.sortedBids().map((l) => Object.freeze({ price: l.price, size: l.size })));
    const asks = Object.freeze(this.sortedAsks().map((l) => Object.freeze({ price: l.price, size: l.size })));
    return Object.freeze({
      tokenId: this.tokenId,
      marketId: this.marketId,
      bookVersion: this.bookVersion,
      connectionEpoch: this.connectionEpoch,
      bids,
      asks,
      sourceTsMs: this.sourceTsMs,
      receivedTsMs: this.receivedTsMs,
      exchangeHash: this.exchangeHash,
      sourceEventId: this.sourceEventId,
      integrity: this.integrity,
    });
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

/**
 * Canonical deterministic serialization of an ImmutableBookView (§12.4):
 * object keys sorted lexicographically, all bigints as base-10 strings,
 * timestamps as JSON integers. Field order (normative, referenced by the
 * capture layer):
 *   asks, bids, bookVersion, connectionEpoch, exchangeHash, integrity,
 *   marketId, receivedTsMs, sourceEventId, sourceTsMs, tokenId
 * Each level serializes as {"price":"<dec>","size":"<dec>"}.
 */
export function canonicalBookSerialization(view: ImmutableBookView): string {
  const level = (l: Readonly<BookLevel>) => `{"price":"${l.price.toString()}","size":"${l.size.toString()}"}`;
  return "{" + [
    `"asks":[${view.asks.map(level).join(",")}]`,
    `"bids":[${view.bids.map(level).join(",")}]`,
    `"bookVersion":"${view.bookVersion.toString()}"`,
    `"connectionEpoch":${JSON.stringify(view.connectionEpoch)}`,
    `"exchangeHash":${view.exchangeHash === null ? "null" : JSON.stringify(view.exchangeHash)}`,
    `"integrity":${JSON.stringify(view.integrity)}`,
    `"marketId":${JSON.stringify(view.marketId)}`,
    `"receivedTsMs":${JSON.stringify(view.receivedTsMs)}`,
    `"sourceEventId":${JSON.stringify(view.sourceEventId)}`,
    `"sourceTsMs":${JSON.stringify(view.sourceTsMs)}`,
    `"tokenId":${JSON.stringify(view.tokenId)}`,
  ].join(",") + "}";
}

/**
 * Canonical LOCAL content hash: sha256 hex over the canonical serialization.
 * Proves immutability of what THIS process saw; it does not prove feed
 * completeness and never upgrades continuity evidence (§12.4).
 */
export function canonicalBookHash(view: ImmutableBookView): string {
  return createHash("sha256").update(canonicalBookSerialization(view), "utf8").digest("hex");
}

/** Complementary-price consistency: UP bid + DOWN ask should be ~1. Returns |1 - (upBid + downAsk)| as prob float. */
export function complementConsistency(up: BookState, down: BookState): number | null {
  const ub = up.bestBid();
  const da = down.bestAsk();
  if (ub === null || da === null) return null;
  return Math.abs(1 - Number(ub + da) / Number(ONE));
}

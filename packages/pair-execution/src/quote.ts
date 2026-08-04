/**
 * Exact per-level direct BUY and SELL quotes (spec §8.4–§8.7, §8.10–§8.11;
 * file-map responsibility per §10.1 `quote.ts`).
 *
 * DIRECT route only (§8.3): BUY consumes asks from lowest price upward; SELL
 * consumes bids from highest price downward. There is deliberately no
 * mirrored/synthetic route here — `min(upAsk, 1 - downBid)` substitution is
 * forbidden by §8.3 and belongs to a different route with different starting
 * assets.
 *
 * All economics are exact bigint fixed-point (6-decimal micro units); the
 * nonlinear taker-fee implementation in `@b5p/domain` is authoritative
 * (§10.2) and is reused per canonical consumed price level (§8.5): the fee
 * is rounded once per modeled fill, never from a rounded average price.
 *
 * Ordinary invalidity (malformed book, bad request, unknown fee convention)
 * is reported through the {@link QuoteResult} discriminated union — this
 * module never throws for expected bad input.
 *
 * The consumed-level and book-reference evidence reuses the normative §11.5
 * contracts directly. {@link DirectLegQuote} remains the matcher-specific
 * projection because it additionally carries top-of-book and impact evidence.
 */

import {
  mulDiv,
  ONE,
  PPM,
  takerFeeShares,
  takerFeeUsdc,
  type BookLevel,
  type Ppm,
  type Prob6,
  type Shares6,
  type Usdc6,
} from "@b5p/domain";
import type {
  PairBookReference,
  PairCaptureId,
  PairLegQuote,
  PairLevelFill,
  PairOutcome,
  PairQuoteEconomics,
  PairQuote,
  PairDepthStressResult,
  PairStressResult,
  PairRejectionCode,
} from "./contracts";
import { canonicalObjectHash } from "./hashes";

export type { PairLevelFill } from "./contracts";

/** Order side of a direct single-token leg. */
export type QuoteOrderSide = "BUY" | "SELL";

/** Time-in-force semantics per §8.4: FOK is all-or-nothing; FAK allows partial fills. */
export type QuoteTimeInForce = "FOK" | "FAK";

/**
 * Fee evidence needed to price one leg: the token-specific rate and the
 * collection convention. Typed as `string` so unknown conventions arriving
 * from external data fail closed (§8.6: `FEE_CONVENTION_UNKNOWN`) instead of
 * being assumed away at the type level.
 */
export interface QuoteFeeSnapshot {
  readonly ratePpm: Ppm;
  readonly collection: string;
}

/** Exact immutable source-book evidence from the normative §11 contracts. */
export type QuoteBookReference = PairBookReference;

/**
 * Normative §11.5 `PairLegQuote` economics plus
 * the §8.4-required top-of-book/impact evidence that §11.5 does not carry.
 *
 * For a BUY leg, `principal6` is total acquisition principal and total cash
 * debited is `principal6 + feeCash6`. For a SELL leg, `principal6` is total
 * gross proceeds and net proceeds are `principal6 - feeCash6` (§8.10).
 */
export interface DirectLegQuote {
  readonly side: QuoteOrderSide;
  readonly requestedGrossShares6: Shares6;
  readonly filledGrossShares6: Shares6;
  /** Shares actually received (BUY) net of share-collected fees; equals filled gross for SELL/USDC. */
  readonly receivedNetShares6: Shares6;
  readonly unfilledGrossShares6: Shares6;
  readonly levels: readonly PairLevelFill[];
  readonly principal6: Usdc6;
  readonly feeCash6: Usdc6;
  readonly feeShares6: Shares6;
  /** Price of the best level of the walked side, or null when the book side was empty. */
  readonly topOfBookPrice6: Prob6 | null;
  /** Worst (last consumed) price, or null when nothing filled. */
  readonly worstPrice6: Prob6 | null;
  /**
   * Principal-weighted average price over gross filled shares, rounded
   * conservatively for the taker: up for BUY, down for SELL (§8.11). Null
   * when nothing filled.
   */
  readonly averagePrice6: Prob6 | null;
  /** |worst - topOfBook| in price micro-units, or null when nothing filled. */
  readonly impactFromTop6: bigint | null;
  /** True iff the full requested quantity was executable within limit/cap. */
  readonly fullyExecutable: boolean;
  readonly bookRef: QuoteBookReference;
}

/** Stable rejection codes; ordinary invalidity is data, not an exception. */
export type QuoteRejectReason =
  /** Unsorted, zero/negative size, zero/above-one price, or otherwise non-canonical levels. */
  | "MALFORMED_BOOK"
  /** Non-positive quantity, out-of-range limit/cap, or degenerate fee rate. */
  | "INVALID_REQUEST"
  /** No authoritative fee evidence was supplied. */
  | "FEE_SNAPSHOT_MISSING"
  /** Collection convention is neither "usdc" nor "shares" (§8.6 fail-closed). */
  | "FEE_CONVENTION_UNKNOWN"
  /** §8.6: V0 never paper-sells under a share-collected convention. */
  | "UNSUPPORTED_SELL_FEE_COLLECTION"
  /** A sell may never quote more token inventory than the caller proves is available. */
  | "INSUFFICIENT_INVENTORY";

export interface QuoteReject {
  readonly ok: false;
  readonly reason: QuoteRejectReason;
  readonly detail: string;
}

export interface QuoteOk {
  readonly ok: true;
  readonly quote: DirectLegQuote;
}

export type QuoteResult = QuoteOk | QuoteReject;

export interface PairQuoteLegInput {
  readonly outcome: PairOutcome;
  readonly tokenId: string;
  readonly quote: DirectLegQuote;
  /** Reservation bound for this leg; defaults to its exact principal plus cash fee. */
  readonly maximumCashDebit6?: Usdc6;
}

export interface ComposePairQuoteInput {
  readonly captureId: PairCaptureId;
  readonly pairGrossShares6: Shares6;
  readonly up: PairQuoteLegInput;
  readonly down: PairQuoteLegInput;
  readonly modeledNonrefundableSettlementCost6: Usdc6;
  readonly settlementCashReserve6: Usdc6;
  readonly recoveryCashReserve6: Usdc6;
  readonly operationalRiskHaircut6: Usdc6;
  /** Costs already irrevocably incurred if only one initial leg fills. */
  readonly alreadyNonrefundableOperationalCosts6?: Usdc6;
}

export type ComposePairQuoteResult =
  | { readonly ok: true; readonly quote: PairQuoteEconomics }
  | { readonly ok: false; readonly code: PairRejectionCode; readonly description: string };

export interface FinalizePairQuoteInput {
  readonly captureId: PairCaptureId;
  readonly economics: PairQuoteEconomics;
  readonly oneTickWorse: PairStressResult;
  readonly twoTicksWorse: PairStressResult;
  readonly depthStress: readonly PairDepthStressResult[];
}

export interface DirectBuyQuoteRequest {
  /** Immutable asks, ascending by price. Equal-price entries are canonically aggregated (§8.5). */
  readonly levels: readonly Readonly<BookLevel>[];
  readonly requestedShares6: Shares6;
  /** Maximum executable ask price (inclusive). Defaults to ONE (price of one). */
  readonly limitPrice6?: Prob6;
  /** Maximum total cash debit (principal + cash fees). Defaults to unbounded. */
  readonly cashCap6?: Usdc6;
  readonly fee: QuoteFeeSnapshot;
  readonly timeInForce: QuoteTimeInForce;
  readonly bookRef: QuoteBookReference;
}

export interface DirectSellQuoteRequest {
  /** Immutable bids, descending by price. Equal-price entries are canonically aggregated (§8.5). */
  readonly levels: readonly Readonly<BookLevel>[];
  readonly requestedShares6: Shares6;
  /** Exact token balance available to this unwind. Required fail-closed sell evidence. */
  readonly availableShares6: Shares6;
  /** Minimum acceptable bid price (inclusive). Defaults to 0. */
  readonly limitPrice6?: Prob6;
  readonly fee: QuoteFeeSnapshot;
  readonly timeInForce: QuoteTimeInForce;
  readonly bookRef: QuoteBookReference;
}

const reject = (reason: QuoteRejectReason, detail: string): QuoteReject => ({ ok: false, reason, detail });

interface CanonicalLevelsOk {
  readonly ok: true;
  readonly levels: readonly BookLevel[];
}

/**
 * Validate and canonically aggregate raw levels (§8.5): prices must be in
 * (0, ONE], sizes strictly positive, and the sequence must be sorted in the
 * walked direction. Exact duplicate prices (necessarily adjacent in a sorted
 * book) are merged into one canonical level whose size is the exact sum, so
 * the fee is rounded once per canonical consumed price level. Anything else
 * malformed rejects the book.
 */
function canonicalizeLevels(
  raw: readonly Readonly<BookLevel>[],
  side: QuoteOrderSide,
): CanonicalLevelsOk | QuoteReject {
  if (!Array.isArray(raw)) {
    return reject("MALFORMED_BOOK", "levels must be an array");
  }
  const out: BookLevel[] = [];
  for (let i = 0; i < raw.length; i++) {
    const lvl = raw[i]!;
    if (lvl === null || typeof lvl !== "object") {
      return reject("MALFORMED_BOOK", `level ${i}: expected an object`);
    }
    if (typeof lvl.price !== "bigint" || typeof lvl.size !== "bigint") {
      return reject("MALFORMED_BOOK", `level ${i}: price and size must be bigint micro-units`);
    }
    if (lvl.price <= 0n) return reject("MALFORMED_BOOK", `level ${i}: price ${lvl.price} is not positive`);
    if (lvl.price > ONE) return reject("MALFORMED_BOOK", `level ${i}: price ${lvl.price} exceeds one`);
    if (lvl.size <= 0n) return reject("MALFORMED_BOOK", `level ${i}: size ${lvl.size} is not positive`);
    const prev = out[out.length - 1];
    if (prev !== undefined) {
      if (lvl.price === prev.price) {
        // Canonical aggregation of duplicate raw entries at an exact price (§8.5).
        out[out.length - 1] = { price: prev.price, size: prev.size + lvl.size };
        continue;
      }
      const outOfOrder = side === "BUY" ? lvl.price < prev.price : lvl.price > prev.price;
      if (outOfOrder) {
        return reject(
          "MALFORMED_BOOK",
          `level ${i}: price ${lvl.price} out of order after ${prev.price} (expects ${side === "BUY" ? "ascending asks" : "descending bids"})`,
        );
      }
    }
    out.push({ price: lvl.price, size: lvl.size });
  }
  return { ok: true, levels: out };
}

function validateCommon(
  requestedShares6: Shares6,
  fee: QuoteFeeSnapshot | null | undefined,
  timeInForce: QuoteTimeInForce,
): QuoteReject | null {
  if (typeof requestedShares6 !== "bigint" || requestedShares6 <= 0n) {
    return reject("INVALID_REQUEST", "requested shares must be a positive bigint");
  }
  if (timeInForce !== "FOK" && timeInForce !== "FAK") {
    return reject("INVALID_REQUEST", "time in force must be FOK or FAK");
  }
  if (fee === null || typeof fee !== "object") {
    return reject("FEE_SNAPSHOT_MISSING", "fee snapshot is required");
  }
  if (fee.collection !== "usdc" && fee.collection !== "shares") {
    return reject("FEE_CONVENTION_UNKNOWN", "fee collection convention must be usdc or shares");
  }
  if (typeof fee.ratePpm !== "bigint" || fee.ratePpm < 0n || fee.ratePpm > PPM) {
    return reject("INVALID_REQUEST", `fee rate must be a bigint within [0, ${PPM}] ppm`);
  }
  return null;
}

/** Largest share quantity whose cash debit at one level stays within `capLeft6`; floor-rounded per §8.11. */
function affordableShares(
  capLeft6: Usdc6,
  price6: Prob6,
  ratePpm: Ppm,
  collection: "usdc" | "shares",
  maxShares: Shares6,
): Shares6 {
  const cashCost = (s: Shares6): Usdc6 =>
    mulDiv(s, price6, ONE, "ceil") + (collection === "usdc" ? takerFeeUsdc(s, price6, ratePpm) : 0n);
  if (cashCost(maxShares) <= capLeft6) return maxShares;
  // Binary search: cashCost is monotone non-decreasing in s.
  let lo = 0n; // affordable
  let hi = maxShares; // not affordable
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (cashCost(mid) <= capLeft6) lo = mid;
    else hi = mid;
  }
  return lo;
}

function assembleQuote(
  side: QuoteOrderSide,
  requested: Shares6,
  levels: readonly PairLevelFill[],
  topOfBook: Prob6 | null,
  executable: boolean,
  bookRef: QuoteBookReference,
): DirectLegQuote {
  const filled = levels.reduce((acc, l) => acc + l.grossShares6, 0n);
  const net = levels.reduce((acc, l) => acc + l.netShares6, 0n);
  const principal = levels.reduce((acc, l) => acc + l.cashPrincipal6, 0n);
  const feeCash = levels.reduce((acc, l) => acc + l.feeCash6, 0n);
  const feeShares = levels.reduce((acc, l) => acc + l.feeShares6, 0n);
  const worst = levels.length > 0 ? levels[levels.length - 1]!.price6 : null;
  const average =
    filled > 0n
      ? // Conservative for the taker: a buy's average cost rounds up, a sell's
        // average proceeds round down (§8.11).
        mulDiv(principal, ONE, filled, side === "BUY" ? "ceil" : "floor")
      : null;
  const impact = worst !== null && topOfBook !== null ? (worst > topOfBook ? worst - topOfBook : topOfBook - worst) : null;
  return Object.freeze({
    side,
    requestedGrossShares6: requested,
    filledGrossShares6: filled,
    receivedNetShares6: net,
    unfilledGrossShares6: requested - filled,
    levels: Object.freeze(levels.slice()),
    principal6: principal,
    feeCash6: feeCash,
    feeShares6: feeShares,
    topOfBookPrice6: topOfBook,
    worstPrice6: worst,
    averagePrice6: average,
    impactFromTop6: impact,
    fullyExecutable: executable,
    bookRef,
  });
}

/**
 * Exact direct BUY walk through asks, lowest price first (§8.4). Per level:
 * cost is `ceil(take * price / 1e6)` and the taker fee comes from the
 * authoritative domain implementation, rounded once per canonical level.
 *
 * FOK: any unfilled micro-share (depth/limit short) or a cash-cap breach
 * produces zero fills and zero cost (§8.4, §24.4). FAK: partial fills are
 * allowed; the unfilled remainder stays explicit.
 */
export function quoteDirectBuy(req: DirectBuyQuoteRequest): QuoteResult {
  const bad = validateCommon(req.requestedShares6, req.fee, req.timeInForce);
  if (bad) return bad;
  const limit = req.limitPrice6 ?? ONE;
  if (typeof limit !== "bigint" || limit <= 0n || limit > ONE) {
    return reject("INVALID_REQUEST", `buy limit price must be a bigint within (0, ${ONE}]`);
  }
  const cap = req.cashCap6;
  if (cap !== undefined && (typeof cap !== "bigint" || cap < 0n)) {
    return reject("INVALID_REQUEST", "cash cap must be a non-negative bigint");
  }
  const canon = canonicalizeLevels(req.levels, "BUY");
  if (!canon.ok) return canon;
  const collection = req.fee.collection as "usdc" | "shares";

  const fills: PairLevelFill[] = [];
  let remaining = req.requestedShares6;
  let capLeft = cap;
  let short = false;
  for (const lvl of canon.levels) {
    if (remaining === 0n) break;
    if (lvl.price > limit) {
      short = true;
      break;
    }
    let take = lvl.size < remaining ? lvl.size : remaining;
    if (capLeft !== undefined) {
      take = affordableShares(capLeft, lvl.price, req.fee.ratePpm, collection, take);
      if (take === 0n) {
        short = true;
        break;
      }
    }
    const principal = mulDiv(take, lvl.price, ONE, "ceil");
    const feeCash = collection === "usdc" ? takerFeeUsdc(take, lvl.price, req.fee.ratePpm) : 0n;
    const feeShares = collection === "shares" ? takerFeeShares(take, lvl.price, req.fee.ratePpm) : 0n;
    if (capLeft !== undefined) capLeft -= principal + feeCash;
    fills.push(
      Object.freeze({
        price6: lvl.price,
        grossShares6: take,
        cashPrincipal6: principal,
        feeCash6: feeCash,
        feeShares6: feeShares,
        netShares6: take - feeShares,
      }),
    );
    remaining -= take;
    if (take < lvl.size) {
      // Cap-bound partial consumption of this level: deeper levels cannot help.
      short = remaining > 0n;
      break;
    }
  }
  if (remaining > 0n) short = true;
  const executable = !short && remaining === 0n;

  const topOfBook = canon.levels.length > 0 ? canon.levels[0]!.price : null;

  if (req.timeInForce === "FOK" && !executable) {
    // All-or-nothing: zero fills, zero cost; the book evidence is retained.
    return { ok: true, quote: assembleQuote("BUY", req.requestedShares6, [], topOfBook, false, req.bookRef) };
  }
  return { ok: true, quote: assembleQuote("BUY", req.requestedShares6, fills, topOfBook, executable, req.bookRef) };
}

/**
 * Exact direct SELL walk through bids, highest price first (§8.10). Per
 * level: gross proceeds are `floor(take * price / 1e6)`, the cash taker fee
 * is rounded up, and net proceeds are gross minus fee. Ask-side prices are
 * never consulted. FOK is all-or-nothing; FAK leaves an exact explicit
 * residual.
 *
 * Fail-closed (§8.6): selling under a share-collected fee convention returns
 * `UNSUPPORTED_SELL_FEE_COLLECTION` — the BUY rule is never assumed symmetric.
 */
export function quoteDirectSell(req: DirectSellQuoteRequest): QuoteResult {
  const bad = validateCommon(req.requestedShares6, req.fee, req.timeInForce);
  if (bad) return bad;
  if (typeof req.availableShares6 !== "bigint" || req.availableShares6 < 0n) {
    return reject("INVALID_REQUEST", "available shares must be a non-negative bigint");
  }
  if (req.requestedShares6 > req.availableShares6) {
    return reject(
      "INSUFFICIENT_INVENTORY",
      `requested ${req.requestedShares6} shares but only ${req.availableShares6} are available`,
    );
  }
  if (req.fee.collection === "shares") {
    return reject(
      "UNSUPPORTED_SELL_FEE_COLLECTION",
      "V0 does not sell under a share-collected fee convention (spec §8.6)",
    );
  }
  const limit = req.limitPrice6 ?? 0n;
  if (typeof limit !== "bigint" || limit < 0n || limit > ONE) {
    return reject("INVALID_REQUEST", `sell limit price must be a bigint within [0, ${ONE}]`);
  }
  const canon = canonicalizeLevels(req.levels, "SELL");
  if (!canon.ok) return canon;

  const fills: PairLevelFill[] = [];
  let remaining = req.requestedShares6;
  let short = false;
  for (const lvl of canon.levels) {
    if (remaining === 0n) break;
    if (lvl.price < limit) {
      short = true;
      break;
    }
    const take = lvl.size < remaining ? lvl.size : remaining;
    const grossProceeds = mulDiv(take, lvl.price, ONE, "floor");
    const feeCash = takerFeeUsdc(take, lvl.price, req.fee.ratePpm);
    fills.push(
      Object.freeze({
        price6: lvl.price,
        grossShares6: take,
        cashPrincipal6: grossProceeds,
        feeCash6: feeCash,
        feeShares6: 0n,
        netShares6: take,
      }),
    );
    remaining -= take;
  }
  if (remaining > 0n) short = true;
  const executable = !short && remaining === 0n;

  const topOfBook = canon.levels.length > 0 ? canon.levels[0]!.price : null;

  if (req.timeInForce === "FOK" && !executable) {
    return { ok: true, quote: assembleQuote("SELL", req.requestedShares6, [], topOfBook, false, req.bookRef) };
  }
  return { ok: true, quote: assembleQuote("SELL", req.requestedShares6, fills, topOfBook, executable, req.bookRef) };
}

function asPairLeg(input: PairQuoteLegInput): PairLegQuote {
  const quote = input.quote;
  return Object.freeze({
    outcome: input.outcome,
    tokenId: input.tokenId,
    orderSide: quote.side,
    requestedGrossShares6: quote.requestedGrossShares6,
    filledGrossShares6: quote.filledGrossShares6,
    receivedNetShares6: quote.receivedNetShares6,
    unfilledGrossShares6: quote.unfilledGrossShares6,
    levels: quote.levels,
    principal6: quote.principal6,
    feeCash6: quote.feeCash6,
    feeShares6: quote.feeShares6,
    worstPrice6: quote.worstPrice6,
    averagePrice6: quote.averagePrice6,
    fullyExecutable: quote.fullyExecutable,
    bookRef: quote.bookRef,
  });
}

/**
 * Compose two independently quoted direct BUY legs into exact complete-set
 * economics (§8.5–§8.8, §14.2.1). Share-collected fees reduce each token
 * balance independently; only the smaller net balance is deterministic payout
 * and any imbalance remains explicit residual inventory.
 */
export function composePairQuote(input: ComposePairQuoteInput): ComposePairQuoteResult {
  const quantities = [
    input.pairGrossShares6,
    input.modeledNonrefundableSettlementCost6,
    input.settlementCashReserve6,
    input.recoveryCashReserve6,
    input.operationalRiskHaircut6,
    input.alreadyNonrefundableOperationalCosts6 ?? 0n,
  ];
  if (quantities.some((value) => typeof value !== "bigint" || value < 0n) || input.pairGrossShares6 === 0n) {
    return { ok: false, code: "NO_EXECUTABLE_SIZE", description: "pair quantity must be positive and all cost/reserve inputs must be non-negative bigints" };
  }
  if (input.up.outcome !== "UP" || input.down.outcome !== "DOWN" || input.up.tokenId.length === 0 || input.down.tokenId.length === 0) {
    return { ok: false, code: "NO_EXECUTABLE_SIZE", description: "pair quote requires identified UP and DOWN legs" };
  }
  const upQuote = input.up.quote;
  const downQuote = input.down.quote;
  if (upQuote.side !== "BUY" || downQuote.side !== "BUY") {
    return { ok: false, code: "NO_EXECUTABLE_SIZE", description: "DIRECT_BUY_BOTH composition accepts BUY quotes only" };
  }
  if (!upQuote.fullyExecutable || upQuote.filledGrossShares6 !== input.pairGrossShares6) {
    return { ok: false, code: "INSUFFICIENT_UP_DEPTH", description: "UP leg is not fully executable for the pair quantity" };
  }
  if (!downQuote.fullyExecutable || downQuote.filledGrossShares6 !== input.pairGrossShares6) {
    return { ok: false, code: "INSUFFICIENT_DOWN_DEPTH", description: "DOWN leg is not fully executable for the pair quantity" };
  }

  const exactUpDebit = upQuote.principal6 + upQuote.feeCash6;
  const exactDownDebit = downQuote.principal6 + downQuote.feeCash6;
  const upMaximumDebit = input.up.maximumCashDebit6 ?? exactUpDebit;
  const downMaximumDebit = input.down.maximumCashDebit6 ?? exactDownDebit;
  if (upMaximumDebit < exactUpDebit || downMaximumDebit < exactDownDebit) {
    return { ok: false, code: "AGGREGATE_CASH_CAP_EXCEEDED", description: "leg maximum cash debit cannot be below its exact quote debit" };
  }

  const mergeableNetShares6 = upQuote.receivedNetShares6 < downQuote.receivedNetShares6
    ? upQuote.receivedNetShares6
    : downQuote.receivedNetShares6;
  const grossPrincipal6 = upQuote.principal6 + downQuote.principal6;
  const totalFeeCash6 = upQuote.feeCash6 + downQuote.feeCash6;
  const quotedCashCost6 = grossPrincipal6 + totalFeeCash6 + input.modeledNonrefundableSettlementCost6;
  const hurdleCost6 = quotedCashCost6 + input.operationalRiskHaircut6;
  const guaranteedPayout6 = mergeableNetShares6;
  const netPnl6 = guaranteedPayout6 - hurdleCost6;
  const netReturnPpm = hurdleCost6 === 0n ? 0n : mulDiv(netPnl6, PPM, hurdleCost6, "floor");
  const alreadyNonrefundable = input.alreadyNonrefundableOperationalCosts6 ?? 0n;
  const upOnlyWorstLoss6 = upMaximumDebit + alreadyNonrefundable;
  const downOnlyWorstLoss6 = downMaximumDebit + alreadyNonrefundable;

  return {
    ok: true,
    quote: Object.freeze({
      pairGrossShares6: input.pairGrossShares6,
      mergeableNetShares6,
      up: asPairLeg(input.up),
      down: asPairLeg(input.down),
      grossPrincipal6,
      totalFeeCash6,
      modeledNonrefundableSettlementCost6: input.modeledNonrefundableSettlementCost6,
      settlementCashReserve6: input.settlementCashReserve6,
      recoveryCashReserve6: input.recoveryCashReserve6,
      operationalRiskHaircut6: input.operationalRiskHaircut6,
      reservedCash6: upMaximumDebit + downMaximumDebit + input.recoveryCashReserve6 + input.settlementCashReserve6,
      guaranteedPayout6,
      grossWalkEdge6: input.pairGrossShares6 - grossPrincipal6,
      netPnl6,
      netReturnPpm,
      upOnlyWorstLoss6,
      downOnlyWorstLoss6,
      worstSingleLegLoss6: upOnlyWorstLoss6 > downOnlyWorstLoss6 ? upOnlyWorstLoss6 : downOnlyWorstLoss6,
      residualUpShares6: upQuote.receivedNetShares6 - mergeableNetShares6,
      residualDownShares6: downQuote.receivedNetShares6 - mergeableNetShares6,
    }),
  };
}

/** Attach stress evidence and a deterministic hash to the selected economics. */
export function finalizePairQuote(input: FinalizePairQuoteInput): PairQuote {
  const hashMaterial = Object.freeze({
    quoteSchemaVersion: 1 as const,
    route: "DIRECT_BUY_BOTH" as const,
    captureId: input.captureId,
    ...input.economics,
    oneTickWorse: input.oneTickWorse,
    twoTicksWorse: input.twoTicksWorse,
    depthStress: Object.freeze(input.depthStress.slice()),
    objectiveVersion: "pair_size_objective_v1" as const,
  });
  return Object.freeze({ ...hashMaterial, quoteHash: canonicalObjectHash(hashMaterial) });
}

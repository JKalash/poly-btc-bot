import { ONE, type BookLevel, type Shares6 } from "@b5p/domain";
import type { PairQuoteEconomics } from "./contracts";

export const PAIR_SIZE_OBJECTIVE_VERSION = "pair_size_objective_v1" as const;

export interface CandidateFrontierInput {
  readonly upAsks: readonly Readonly<BookLevel>[];
  readonly downAsks: readonly Readonly<BookLevel>[];
  readonly pairShareLot6: Shares6;
  readonly minimumOrderShares6?: Shares6;
  readonly upMinimumOrderShares6?: Shares6;
  readonly downMinimumOrderShares6?: Shares6;
  /** Exact quantities derived by callers from nonlinear cash/residual solvers. */
  readonly cashCapQuantity6?: Shares6;
  readonly residualCapQuantity6?: Shares6;
  readonly additionalBreakpoints6?: readonly Shares6[];
  readonly maximumPairShares6?: Shares6 | null;
}

export type CandidateFrontierResult =
  | { readonly ok: true; readonly candidates6: readonly Shares6[] }
  | { readonly ok: false; readonly reason: "INVALID_FRONTIER_INPUT"; readonly detail: string };

function floorLot(value: bigint, lot: bigint): bigint {
  return (value / lot) * lot;
}

function ceilLot(value: bigint, lot: bigint): bigint {
  return value === 0n ? 0n : ((value + lot - 1n) / lot) * lot;
}

function cumulativeBreakpoints(levels: readonly Readonly<BookLevel>[]): readonly bigint[] | null {
  let cumulative = 0n;
  let previousPrice: bigint | null = null;
  const out: bigint[] = [];
  for (const level of levels) {
    if (typeof level.price !== "bigint" || typeof level.size !== "bigint" || level.price <= 0n || level.price > ONE || level.size <= 0n) return null;
    if (previousPrice !== null && level.price < previousPrice) return null;
    cumulative += level.size;
    out.push(cumulative);
    previousPrice = level.price;
  }
  return out;
}

/**
 * Build the finite §13.2 quantity frontier. Runtime is proportional to book
 * levels plus explicit cap breakpoints; it never increments through shares.
 */
export function buildCandidateFrontier(input: CandidateFrontierInput): CandidateFrontierResult {
  const lot = input.pairShareLot6;
  const minimum = [
    input.minimumOrderShares6 ?? 0n,
    input.upMinimumOrderShares6 ?? 0n,
    input.downMinimumOrderShares6 ?? 0n,
  ].reduce((a, b) => a > b ? a : b, 0n);
  if (typeof lot !== "bigint" || lot <= 0n || typeof minimum !== "bigint" || minimum <= 0n) {
    return { ok: false, reason: "INVALID_FRONTIER_INPUT", detail: "lot and effective minimum must be positive bigints" };
  }
  const up = cumulativeBreakpoints(input.upAsks);
  const down = cumulativeBreakpoints(input.downAsks);
  if (up === null || down === null) {
    return { ok: false, reason: "INVALID_FRONTIER_INPUT", detail: "ask levels must be ascending with positive bigint price and size" };
  }
  const upDepth = up[up.length - 1] ?? 0n;
  const downDepth = down[down.length - 1] ?? 0n;
  let eligibleDepth = upDepth < downDepth ? upDepth : downDepth;
  if (input.maximumPairShares6 !== undefined && input.maximumPairShares6 !== null) {
    if (typeof input.maximumPairShares6 !== "bigint" || input.maximumPairShares6 < 0n) {
      return { ok: false, reason: "INVALID_FRONTIER_INPUT", detail: "maximum pair shares must be a non-negative bigint or null" };
    }
    if (input.maximumPairShares6 < eligibleDepth) eligibleDepth = input.maximumPairShares6;
  }
  const explicit = [input.cashCapQuantity6, input.residualCapQuantity6, ...(input.additionalBreakpoints6 ?? [])]
    .filter((value): value is bigint => value !== undefined);
  if (explicit.some((value) => typeof value !== "bigint" || value < 0n)) {
    return { ok: false, reason: "INVALID_FRONTIER_INPUT", detail: "cap breakpoints must be non-negative bigints" };
  }

  const set = new Set<bigint>();
  // The first valid lot at/above a non-aligned venue minimum is a required
  // boundary. All other source boundaries are conservatively rounded down.
  set.add(ceilLot(minimum, lot));
  for (const raw of [...up, ...down, ...explicit, eligibleDepth]) set.add(floorLot(raw, lot));
  const candidates = [...set]
    .filter((value) => value > 0n && value >= minimum && value <= eligibleDepth)
    .sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  return { ok: true, candidates6: Object.freeze(candidates) };
}

export interface PairSizeCandidate {
  readonly quote: PairQuoteEconomics;
  readonly oneTickWorseNetPnl6: bigint;
}

/** Negative means `left` ranks ahead of `right` under §13.3. */
export function pairSizeObjectiveV1(left: PairSizeCandidate, right: PairSizeCandidate): number {
  const comparisons: readonly [bigint, bigint, "HIGH" | "LOW"][] = [
    [left.quote.netPnl6, right.quote.netPnl6, "HIGH"],
    [left.oneTickWorseNetPnl6, right.oneTickWorseNetPnl6, "HIGH"],
    [left.quote.reservedCash6, right.quote.reservedCash6, "LOW"],
    [left.quote.worstSingleLegLoss6, right.quote.worstSingleLegLoss6, "LOW"],
    [left.quote.pairGrossShares6, right.quote.pairGrossShares6, "LOW"],
  ];
  for (const [a, b, preference] of comparisons) {
    if (a === b) continue;
    if (preference === "HIGH") return a > b ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

export function selectBestPairCandidate(candidates: readonly PairSizeCandidate[]): PairSizeCandidate | null {
  let best: PairSizeCandidate | null = null;
  for (const candidate of candidates) {
    if (best === null || pairSizeObjectiveV1(candidate, best) < 0) best = candidate;
  }
  return best;
}

/** Exact largest lot-aligned quantity under a caller-provided cap quantity. */
export function lotBoundedQuantity(capQuantity6: Shares6, lot6: Shares6): Shares6 | null {
  if (typeof capQuantity6 !== "bigint" || capQuantity6 < 0n || typeof lot6 !== "bigint" || lot6 <= 0n) return null;
  return floorLot(capQuantity6, lot6);
}

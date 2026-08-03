import { mulDiv, ONE, PPM, type Ppm, type Prob6, type Shares6, type Usdc6 } from "./fixed";

/**
 * Polymarket crypto fee model, verified live 2026-07-31 on a btc-updown-5m market:
 *   feeType "crypto_fees_v2", feeSchedule { rate: 0.07, takerOnly: true, rebateRate: 0.2 }
 * Docs formula: fee = shares * rate * p * (1 - p), taker-only, makers pay zero.
 *
 * Collection convention:
 *  - Current docs state fees are charged in USDC at settlement ("usdc").
 *  - The original spec assumed buy-side fees are collected in shares ("shares").
 * Both are implemented; the active convention is configuration, and the decision
 * snapshot records which one priced the trade. Break-evens differ by <0.01% at
 * p=0.95 but the accounting paths differ, so both are kept exact.
 */
export interface FeeSchedule {
  /** e.g. 70_000n for 7% */
  ratePpm: Ppm;
  takerOnly: boolean;
  /** informational; rebates are never counted as pre-trade edge */
  rebateRatePpm: Ppm;
  collection: "usdc" | "shares";
}

/** Taker fee in micro-USDC for a trade of `sh` shares at price `p`. Rounded up (conservative for the payer). */
export function takerFeeUsdc(sh: Shares6, p: Prob6, ratePpm: Ppm): Usdc6 {
  // shares6 * ratePpm * p6 * (1-p)6 / 1e18  -> micro-USDC
  return mulDiv(sh * ratePpm, p * (ONE - p), 10n ** 18n, "ceil");
}

/** Share-collected convention: fee shares deducted from a winning buy of `sh` gross shares. */
export function takerFeeShares(sh: Shares6, p: Prob6, ratePpm: Ppm): Shares6 {
  // fee_usd / p = sh * rate * (1 - p)
  return mulDiv(sh, ratePpm * (ONE - p), PPM * ONE, "ceil");
}

export function netWinningSharesShareCollected(sh: Shares6, p: Prob6, ratePpm: Ppm): Shares6 {
  return sh - takerFeeShares(sh, p, ratePpm);
}

/** Maker break-even probability: price itself (maker fee is zero). */
export const breakEvenMaker = (p: Prob6): Prob6 => p;

/** Taker break-even, USDC-collected: q* = p * (1 + f*(1-p)) = p + f*p*(1-p). Rounded up. */
export function breakEvenTakerUsdcCollected(p: Prob6, ratePpm: Ppm): Prob6 {
  return p + mulDiv(ratePpm * p, ONE - p, PPM * ONE, "ceil");
}

/** Taker break-even, share-collected: q* = p / (1 - f*(1-p)). Rounded up. */
export function breakEvenTakerShareCollected(p: Prob6, ratePpm: Ppm): Prob6 {
  // Single exact ceiling division on the full rational — flooring an
  // intermediate fee factor inflates the denominator and can land 1 micro-unit
  // BELOW the true ceiling, violating the conservative-rounding contract:
  //   q* = ceil( p * PPM * ONE / (PPM*ONE - ratePpm*(ONE - p)) )
  const denom = PPM * ONE - ratePpm * (ONE - p);
  if (denom <= 0n) throw new Error("degenerate fee schedule");
  return mulDiv(p * PPM, ONE, denom, "ceil");
}

export function breakEvenTaker(p: Prob6, sched: Pick<FeeSchedule, "ratePpm" | "collection">): Prob6 {
  return sched.collection === "usdc"
    ? breakEvenTakerUsdcCollected(p, sched.ratePpm)
    : breakEvenTakerShareCollected(p, sched.ratePpm);
}

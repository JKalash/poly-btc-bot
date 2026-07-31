import { breakEvenTaker, type FeeSchedule } from "./fees";
import { ONE, PPM, mulDiv, type Ppm, type Prob6 } from "./fixed";

/**
 * Fractional Kelly sizing. Fractions are expressed in ppm of bankroll.
 * Kelly must always be fed the CONSERVATIVE probability, never the point estimate.
 */

/** Generic Kelly for a binary bet with net odds b = bNum/bDen: f* = q - (1-q)/b. Floored at 0. */
function kellyGeneric(q: Prob6, bNum: bigint, bDen: bigint): Ppm {
  if (bNum <= 0n) return 0n;
  const f = q - mulDiv(ONE - q, bDen, bNum, "ceil");
  return f > 0n ? f : 0n;
}

/** Maker buy at price p: b = (1-p)/p, so f* = (q - p) / (1 - p). */
export function fullKellyMaker(q: Prob6, p: Prob6): Ppm {
  if (p >= ONE) return 0n;
  return kellyGeneric(q, ONE - p, p);
}

/** Taker buy: odds derived from the fee-adjusted cost-equivalent probability. */
export function fullKellyTaker(q: Prob6, p: Prob6, sched: Pick<FeeSchedule, "ratePpm" | "collection">): Ppm {
  const be = breakEvenTaker(p, sched);
  if (be >= ONE) return 0n;
  return kellyGeneric(q, ONE - be, be);
}

/** Apply the profile's Kelly multiplier (ppm). */
export function fractionalKelly(fullKelly: Ppm, multiplierPpm: Ppm): Ppm {
  return mulDiv(fullKelly, multiplierPpm, PPM, "floor");
}

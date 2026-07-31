import { breakEvenTaker, type FeeSchedule } from "./fees";
import { ONE, PPM, mulDiv, toNumber, type Ppm, type Prob6 } from "./fixed";

/**
 * Expected value per unit cost. Gate checks are exact integer comparisons
 * (no floats); the numeric ev values are for display only.
 */

/** Display: maker EV per cost = q/p - 1 */
export function makerEvPerCost(q: Prob6, p: Prob6): number {
  return toNumber(mulDiv(q, ONE, p, "floor")) - 1;
}

/** Display: taker EV per cost under the active fee collection convention. */
export function takerEvPerCost(q: Prob6, p: Prob6, sched: Pick<FeeSchedule, "ratePpm" | "collection">): number {
  const be = breakEvenTaker(p, sched); // cost-equivalent probability
  return toNumber(mulDiv(q, ONE, be, "floor")) - 1;
}

/** Exact gate: q/p - 1 >= minEdge  <=>  q * PPM >= p * (PPM + minEdge) */
export function makerEdgeSatisfied(q: Prob6, p: Prob6, minEdgePpm: Ppm): boolean {
  return q * PPM >= p * (PPM + minEdgePpm);
}

/** Exact gate for takers: q >= breakEven * (1 + minEdge), break-even already conservatively rounded up. */
export function takerEdgeSatisfied(q: Prob6, p: Prob6, sched: Pick<FeeSchedule, "ratePpm" | "collection">, minEdgePpm: Ppm): boolean {
  const be = breakEvenTaker(p, sched);
  return q * PPM >= be * (PPM + minEdgePpm);
}

/** How many wins of size `gross_win = stake*(1-p)/p` does one full loss of `stake` erase? */
export function lossErasesWins(p: Prob6): number {
  // stake / (stake*(1-p)/p) = p/(1-p)
  if (p >= ONE) return Infinity;
  return toNumber(mulDiv(p, ONE, ONE - p, "half-even"));
}

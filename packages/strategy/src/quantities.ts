import type { ExecutionStyle, OutcomeSide, SignalQuantities } from "@b5p/domain";

export type { SignalQuantities };

/**
 * The eight signal quantities, kept DISTINCT end-to-end (snake_case names are
 * the cross-language contract; fields are the repo's camelCase):
 *
 *   market_probability             marketProbability
 *   model_probability              modelProbability
 *   conservative_probability       conservativeProbability
 *   score_strength                 scoreStrength
 *   effective_break_even_probability effectiveBreakEvenProbability
 *   fill_probability               fillProbability
 *   expected_value_if_filled       expectedValueIfFilled
 *   expected_value_per_signal      expectedValuePerSignal   (new)
 *
 * INVARIANTS enforced here:
 *  - score_strength is a raw score, NEVER a probability, and NEVER feeds any
 *    EV computation. An uncalibrated score with no model_probability yields
 *    null EVs — a composite score cannot fabricate expected value.
 *  - Every quantity is per-side (the side being bought), in probability units.
 *  - These are DIAGNOSTIC doubles (research statistics, matching
 *    @b5p/experiments/metrics). The authoritative approve/size path stays in
 *    bigint Prob6 inside @b5p/risk (conservativeProbability -> Kelly); nothing
 *    here sizes money.
 *
 * The SignalQuantities type is canonical in @b5p/domain (next to
 * DecisionSnapshotData) and re-exported above; the computation lives here.
 */

export interface SignalQuantityInputs {
  side: OutcomeSide;
  style: ExecutionStyle;
  /** Executable price of the SIDE token (maker: resting price; taker: ask). */
  entryPrice: number | null;
  /** Taker fee rate (crypto_fees_v2: 0.07). Makers pay no taker fee. */
  feeRate: number;
  marketProbability: number | null;
  modelProbability: number | null;
  conservativeProbability: number | null;
  scoreStrength: number | null;
  /** Maker fills from measured touch/through rates; taker ~1 when marketable. */
  fillProbability: number | null;
  /** Probability points lost to quote latency between decision and execution. */
  latencyProbPenalty: number;
  /** Probability points lost to adverse selection CONDITIONAL on a maker fill (measured 0.088). */
  adverseSelectionProbPenalty: number;
}

/** Taker break-even: p_be = price * (1 + fee * (1 - price)) — fee on winnings convention. */
export function takerBreakEvenProbability(price: number, feeRate: number): number {
  return price * (1 + feeRate * (1 - price));
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * Compute the eight quantities. Pure. Returns null EVs rather than guessing:
 * no calibrated model probability -> no expected value, whatever the score says.
 */
export function computeSignalQuantities(inp: SignalQuantityInputs): SignalQuantities {
  const isMaker = inp.style === "maker_post_only";

  const effectiveBreakEvenProbability =
    inp.entryPrice === null ? null : isMaker ? inp.entryPrice : takerBreakEvenProbability(inp.entryPrice, inp.feeRate);

  // EV strictly requires a CALIBRATED model probability and a break-even.
  let expectedValueIfFilled: number | null = null;
  if (inp.modelProbability !== null && effectiveBreakEvenProbability !== null && effectiveBreakEvenProbability > 0) {
    const adverse = isMaker ? inp.adverseSelectionProbPenalty : 0;
    const pAdjusted = clamp01(inp.modelProbability - inp.latencyProbPenalty - adverse);
    expectedValueIfFilled = pAdjusted / effectiveBreakEvenProbability - 1;
  }

  const expectedValuePerSignal =
    expectedValueIfFilled === null || inp.fillProbability === null
      ? null
      : clamp01(inp.fillProbability) * expectedValueIfFilled;

  return {
    marketProbability: inp.marketProbability,
    modelProbability: inp.modelProbability,
    conservativeProbability: inp.conservativeProbability,
    scoreStrength: inp.scoreStrength,
    effectiveBreakEvenProbability,
    fillProbability: inp.fillProbability,
    expectedValueIfFilled,
    expectedValuePerSignal,
  };
}

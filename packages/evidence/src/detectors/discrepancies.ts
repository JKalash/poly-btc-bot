import type { FavoredSideBandsData } from "../fixtures/reddit-favored-side-bands";
import type { LagArmAndWatchData } from "../fixtures/reddit-lag-arm-and-watch";

/**
 * Discrepancy detectors mandated by 2026-07-31-001-initial-refinement.fable,
 * "## Source-fixture tests" (lines 1461-1469):
 *  - "The favored-side count mismatch is detected."           -> detectFavoredSideCountGap
 *  - "The 74.8 versus 75.3 rounded-gap discrepancy is detected." -> detectMomentumGapRoundingMismatch
 *  - "The 25%-risk four-loss calculation reports approximately 68.36% lost."
 *                                                             -> gistSafeModeFourLossDrawdown
 *
 * All pure functions over fixture data. Percentages arrive as integer tenths
 * (no floats); bankroll arithmetic is exact bigint rational math per the
 * repo's no-float-money convention.
 */

// ---------------------------------------------------------------------------
// (a) Favored-side band counts: 4,442 displayed vs 4,569 claimed.
// ---------------------------------------------------------------------------

export interface FavoredSideCountGapResult {
  /** Sum of the displayed per-band Ns. */
  displayedSum: number;
  /** Total the source claims for the study. */
  claimedDecisions: number;
  /** claimedDecisions - displayedSum; 127 on the source's numbers. */
  missingDecisions: number;
  /** True when the displayed rows do not account for every claimed decision. */
  mismatch: boolean;
}

export function detectFavoredSideCountGap(data: FavoredSideBandsData): FavoredSideCountGapResult {
  const displayedSum = data.rows.reduce((acc, r) => acc + r.n, 0);
  const missingDecisions = data.claimedDecisions - displayedSum;
  return {
    displayedSum,
    claimedDecisions: data.claimedDecisions,
    missingDecisions,
    mismatch: missingDecisions !== 0,
  };
}

/**
 * Bonus row-level check: a band row whose printed "actual minus break-even"
 * differs from the subtraction of its own printed columns (the 0.55–0.60 row
 * prints -2.1pp while 57.1 - 59.3 = -2.2pp). Exact integer-tenths arithmetic.
 */
export interface BandRowDiffInconsistency {
  band: string;
  printedDiffPpTenths: number;
  computedDiffPpTenths: number;
}

export function detectBandRowDiffInconsistencies(
  data: FavoredSideBandsData,
): BandRowDiffInconsistency[] {
  const out: BandRowDiffInconsistency[] = [];
  for (const r of data.rows) {
    const computed = r.actualWinRatePctTenths - r.claimedBreakEvenPctTenths;
    if (computed !== r.actualMinusBreakEvenPpTenthsAsPrinted) {
      out.push({
        band: r.band,
        printedDiffPpTenths: r.actualMinusBreakEvenPpTenthsAsPrinted,
        computedDiffPpTenths: computed,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// (b) 74.8% resolution vs 75.3% ask: visible rounded gap -0.5pp, reported -0.4pp.
// ---------------------------------------------------------------------------

export interface MomentumGapRoundingResult {
  /** Momentum-side resolution rate, tenths of a percent (748). */
  resolutionPctTenths: number;
  /** Observed Polymarket ask, tenths of a percent (753). */
  askPctTenths: number;
  /** Subtraction of the visible rounded figures, tenths of a pp (-5). */
  visibleGapPpTenths: number;
  /** Gap as reported by the post, tenths of a pp (-4). */
  reportedGapPpTenths: number;
  /** reported - visible, tenths of a pp (+1 on the source's numbers). */
  reconciliationPpTenths: number;
  /** True when the printed figures do not reproduce the reported gap. */
  mismatch: boolean;
}

export function detectMomentumGapRoundingMismatch(
  data: LagArmAndWatchData,
): MomentumGapRoundingResult {
  const visibleGapPpTenths =
    data.momentumSideResolutionPctTenths - data.observedPolymarketAskPctTenths;
  const reconciliationPpTenths = data.reportedGapPpTenths - visibleGapPpTenths;
  return {
    resolutionPctTenths: data.momentumSideResolutionPctTenths,
    askPctTenths: data.observedPolymarketAskPctTenths,
    visibleGapPpTenths,
    reportedGapPpTenths: data.reportedGapPpTenths,
    reconciliationPpTenths,
    mismatch: reconciliationPpTenths !== 0,
  };
}

// ---------------------------------------------------------------------------
// (c) Gist "safe" mode: 25% risk, four consecutive losses. Exact rationals.
// ---------------------------------------------------------------------------

export interface ExactFraction {
  numerator: bigint;
  denominator: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

export function reduceFraction(f: ExactFraction): ExactFraction {
  if (f.denominator === 0n) throw new Error("reduceFraction: zero denominator");
  const g = gcd(f.numerator, f.denominator);
  const sign = f.denominator < 0n ? -1n : 1n;
  return {
    numerator: (sign * f.numerator) / (g === 0n ? 1n : g),
    denominator: (sign * f.denominator) / (g === 0n ? 1n : g),
  };
}

/**
 * Exact decimal expansion of a non-negative proper-or-improper fraction.
 * Returns the exact string when the expansion terminates within maxDigits
 * (all power-of-2/5 denominators do), otherwise truncates and flags it.
 */
export function fractionToDecimalString(
  f: ExactFraction,
  maxDigits = 32,
): { decimal: string; exact: boolean } {
  if (f.numerator < 0n || f.denominator <= 0n) {
    throw new Error("fractionToDecimalString: expects non-negative numerator, positive denominator");
  }
  const whole = f.numerator / f.denominator;
  let rem = f.numerator % f.denominator;
  if (rem === 0n) return { decimal: whole.toString(), exact: true };
  let digits = "";
  for (let i = 0; i < maxDigits && rem !== 0n; i++) {
    rem *= 10n;
    digits += (rem / f.denominator).toString();
    rem %= f.denominator;
  }
  return { decimal: `${whole.toString()}.${digits}`, exact: rem === 0n };
}

/** Round num/den * 100 (a percent) half-up to two decimals, as a string like "68.36". */
export function fractionToPercentString2dp(f: ExactFraction): string {
  if (f.numerator < 0n || f.denominator <= 0n) {
    throw new Error("fractionToPercentString2dp: expects non-negative fraction");
  }
  // percent * 100 (i.e. basis points of 1) rounded half-up
  const scaled = (f.numerator * 10000n * 2n + f.denominator) / (2n * f.denominator);
  const whole = scaled / 100n;
  const frac = (scaled % 100n).toString().padStart(2, "0");
  return `${whole.toString()}.${frac}`;
}

export interface ConsecutiveLossDrawdownResult {
  /** Fraction of bankroll risked per trade, reduced. */
  riskPerTrade: ExactFraction;
  consecutiveLosses: number;
  /** Fraction of bankroll retained: (1 - risk)^losses, reduced. */
  retained: ExactFraction;
  /** Fraction of bankroll lost: 1 - retained, reduced. */
  lost: ExactFraction;
  /** Exact decimal expansions (exact for power-of-2/5 denominators). */
  retainedDecimal: string;
  lostDecimal: string;
  /** Percent strings rounded half-up to 2dp, e.g. "68.36" / "31.64". */
  lostPercent2dp: string;
  retainedPercent2dp: string;
}

/**
 * Exact drawdown after `losses` consecutive full losses of a fixed bankroll
 * fraction. No floats: bigint rational arithmetic throughout.
 */
export function drawdownAfterConsecutiveLosses(
  riskPerTrade: ExactFraction,
  losses: number,
): ConsecutiveLossDrawdownResult {
  if (!Number.isInteger(losses) || losses < 0) {
    throw new Error("drawdownAfterConsecutiveLosses: losses must be a non-negative integer");
  }
  const risk = reduceFraction(riskPerTrade);
  if (risk.numerator < 0n || risk.numerator > risk.denominator) {
    throw new Error("drawdownAfterConsecutiveLosses: risk must be within [0, 1]");
  }
  const n = BigInt(losses);
  const retained = reduceFraction({
    numerator: (risk.denominator - risk.numerator) ** n,
    denominator: risk.denominator ** n,
  });
  const lost = reduceFraction({
    numerator: retained.denominator - retained.numerator,
    denominator: retained.denominator,
  });
  return {
    riskPerTrade: risk,
    consecutiveLosses: losses,
    retained,
    lost,
    retainedDecimal: fractionToDecimalString(retained).decimal,
    lostDecimal: fractionToDecimalString(lost).decimal,
    lostPercent2dp: fractionToPercentString2dp(lost),
    retainedPercent2dp: fractionToPercentString2dp(retained),
  };
}

/**
 * The mandated check on the gist's "safe" mode: 25% of bankroll per trade,
 * four consecutive losses -> exactly 175/256 lost (0.68359375, ~68.36%) and
 * 81/256 retained (0.31640625, ~31.64%). The source labels this "safe"; the
 * arithmetic is why that label is misleading.
 */
export function gistSafeModeFourLossDrawdown(): ConsecutiveLossDrawdownResult {
  return drawdownAfterConsecutiveLosses({ numerator: 1n, denominator: 4n }, 4);
}

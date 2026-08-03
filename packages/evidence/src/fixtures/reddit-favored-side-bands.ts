import { redditRef, type SourceFixture } from "./provenance";

/**
 * Favored-side price-band calibration table.
 *
 * Provenance: 2026-07-31-001-initial-refinement.fable,
 * "## Favored-side price-band result", lines 268-291 (table lines 274-281,
 * count-gap note line 283; the 4,569-decision claim also appears at line 153).
 *
 * KNOWN SOURCE DISCREPANCIES (transcribed, not corrected):
 *  1. Band counts sum to 4,442, but the source claims 4,569 decisions over
 *     4,604 resolved windows — 127 decisions are unaccounted for
 *     (detector: detectFavoredSideCountGap).
 *  2. Row 0.55–0.60 prints "-2.1pp" but 57.1% - 59.3% = -2.2pp. The printed
 *     value is preserved in `actualMinusBreakEvenPpTenthsAsPrinted`; the row
 *     internal inconsistency is surfaced by detectBandRowDiffInconsistencies.
 */

export interface FavoredSideBandRow {
  /** Band label exactly as printed. */
  band: string;
  /** Band lower bound, token price in cents. */
  askMinCents: number;
  /** Band upper bound, token price in cents. */
  askMaxCents: number;
  /** Decision count in this band, as printed. */
  n: number;
  /** Actual win rate, tenths of a percent (49.8% = 498). */
  actualWinRatePctTenths: number;
  /** Source's claimed break-even win rate, tenths of a percent. */
  claimedBreakEvenPctTenths: number;
  /**
   * "Actual minus break-even" EXACTLY as the source prints it, in tenths of a
   * percentage point. NOTE: for the 0.55–0.60 row this does not equal
   * actualWinRatePctTenths - claimedBreakEvenPctTenths (printed -21, computed -22).
   */
  actualMinusBreakEvenPpTenthsAsPrinted: number;
}

export interface FavoredSideBandsData {
  /** "4,569 decisions" claimed by the source (line 153, line 270). */
  claimedDecisions: number;
  /** "4,604 resolved windows" claimed by the source. */
  claimedResolvedWindows: number;
  /** Methodology as claimed: recorded real books, hold-to-resolution, favored-side buy at actual ask. */
  methodology: string;
  /** Fee assumption used by the source for break-evens: fee = shares * 0.072 * price * (1 - price). */
  sourceTakerFeeParameterAsPrinted: "0.072";
  rows: FavoredSideBandRow[];
}

export const REDDIT_FAVORED_SIDE_BANDS: SourceFixture<FavoredSideBandsData> = {
  id: "reddit_favored_side_bands_v1",
  title: "Reddit favored-side price-band calibration (claimed 4,569 decisions / 4,604 windows)",
  label: "SOURCE_CLAIM_UNVERIFIED",
  claimText:
    "Hold-to-resolution favored-side buys at the actual recorded ask underperform the " +
    "fee-adjusted break-even in every price band; displayed band counts sum to 4,442 " +
    "while the study is described as 4,569 decisions.",
  sourceRef: redditRef(
    "favored_side_calibration_table",
    "## Favored-side price-band result",
    { start: 268, end: 291 },
  ),
  data: {
    claimedDecisions: 4569,
    claimedResolvedWindows: 4604,
    methodology:
      "Recorded real books; hold-to-resolution favored-side buy at the actual ask with the source's fee assumption.",
    sourceTakerFeeParameterAsPrinted: "0.072",
    rows: [
      { band: "0.50–0.55", askMinCents: 50, askMaxCents: 55, n: 466, actualWinRatePctTenths: 498, claimedBreakEvenPctTenths: 543, actualMinusBreakEvenPpTenthsAsPrinted: -45 },
      { band: "0.55–0.60", askMinCents: 55, askMaxCents: 60, n: 604, actualWinRatePctTenths: 571, claimedBreakEvenPctTenths: 593, actualMinusBreakEvenPpTenthsAsPrinted: -21 },
      { band: "0.60–0.65", askMinCents: 60, askMaxCents: 65, n: 671, actualWinRatePctTenths: 605, claimedBreakEvenPctTenths: 642, actualMinusBreakEvenPpTenthsAsPrinted: -37 },
      { band: "0.65–0.70", askMinCents: 65, askMaxCents: 70, n: 636, actualWinRatePctTenths: 626, claimedBreakEvenPctTenths: 691, actualMinusBreakEvenPpTenthsAsPrinted: -65 },
      { band: "0.70–0.80", askMinCents: 70, askMaxCents: 80, n: 1107, actualWinRatePctTenths: 747, claimedBreakEvenPctTenths: 763, actualMinusBreakEvenPpTenthsAsPrinted: -16 },
      { band: "0.80–0.95", askMinCents: 80, askMaxCents: 95, n: 958, actualWinRatePctTenths: 847, claimedBreakEvenPctTenths: 883, actualMinusBreakEvenPpTenthsAsPrinted: -36 },
    ],
  },
};

import { redditRef, type SourceFixture } from "./provenance";

/**
 * "Arm-and-watch" lag/arbitrage result (the 74.8% vs 75.3% study).
 *
 * Provenance: 2026-07-31-001-initial-refinement.fable,
 * "## Lag/arbitrage result", lines 196-220 (arm-and-watch bullets 198-205,
 * reconciliation note line 207, offset-strategy bullets 209-214).
 *
 * KNOWN SOURCE DISCREPANCY (transcribed, not corrected): the visible rounded
 * values subtract to -0.5pp (74.8 - 75.3) while the post reports a gap of
 * -0.4pp. The brief mandates preserving this as a reconciliation issue
 * (detector: detectMomentumGapRoundingMismatch).
 */

export interface LagArmAndWatchData {
  /** "5,826 entries". */
  entries: number;
  /** Feeds were offset-corrected, per the source. */
  offsetCorrected: true;
  /** Momentum-side resolution rate, tenths of a percent (74.8% = 748). */
  momentumSideResolutionPctTenths: number;
  /** Observed Polymarket ask, tenths of a percent (75.3% = 753). */
  observedPolymarketAskPctTenths: number;
  /** Gap as REPORTED by the post, tenths of a percentage point (-0.4pp = -4). */
  reportedGapPpTenths: number;
  /** Source conclusion. */
  conclusion: "no fillable lag";
  /** Companion Chainlink/Binance offset-strategy claims (same section). */
  offsetStrategy: {
    /** "approximately +$456" apparent profit, in cents (45600). */
    apparentProfitUsdCentsApprox: number;
    /** Structural ETH Binance-to-Chainlink offset, ppm (0.12% = 1200), printed as approximate. */
    structuralOffsetPpmApprox: number;
    /** Entry threshold, ppm (0.10% = 1000). */
    entryThresholdPpm: number;
    /** Apparent profit disappeared after offset correction. */
    profitDisappearedAfterOffsetCorrection: true;
  };
}

export const REDDIT_LAG_ARM_AND_WATCH: SourceFixture<LagArmAndWatchData> = {
  id: "reddit_lag_arm_and_watch_v1",
  title: "Reddit arm-and-watch lag study (5,826 entries; 74.8% resolved vs 75.3% ask)",
  label: "SOURCE_CLAIM_UNVERIFIED",
  claimText:
    "With offset-corrected feeds over 5,826 entries, the momentum side resolved 74.8% " +
    "while the Polymarket ask averaged 75.3%; the post reports a -0.4pp gap (rounded " +
    "figures subtract to -0.5pp) and concludes there was no fillable lag. An apparent " +
    "+$456 Chainlink/Binance offset strategy (0.10% entry threshold vs ~0.12% structural " +
    "offset) disappeared after offset correction.",
  sourceRef: redditRef(
    "arm_and_watch_lag_result",
    "## Lag/arbitrage result",
    { start: 196, end: 220 },
  ),
  data: {
    entries: 5826,
    offsetCorrected: true,
    momentumSideResolutionPctTenths: 748,
    observedPolymarketAskPctTenths: 753,
    reportedGapPpTenths: -4,
    conclusion: "no fillable lag",
    offsetStrategy: {
      apparentProfitUsdCentsApprox: 45600,
      structuralOffsetPpmApprox: 1200,
      entryThresholdPpm: 1000,
      profitDisappearedAfterOffsetCorrection: true,
    },
  },
};

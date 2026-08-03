import { redditRef, type SourceFixture } from "./provenance";

/**
 * Exit-engineering result: pullback depth and recovery for winners vs losers.
 *
 * Provenance: 2026-07-31-001-initial-refinement.fable,
 * "## Exit-engineering result", lines 327-347 (claims at lines 331-340).
 *
 * The brief lists these as prose bullets, not a markdown table; they are the
 * exit pullback/recovery numbers acceptance criterion 12 requires reproduced.
 * "approximately"-qualified values are flagged with an `...Approx` suffix.
 */

export interface ExitPullbackRecoveryData {
  /** "trailing stops at every tested percentage consistently cut winners" (qualitative). */
  trailingStopsCutWinnersAtEveryTestedPct: true;
  /** "58% of eventual winners first fell approximately 10% before recovering". */
  winnersThatFirstFell: {
    shareOfWinnersPctTenths: number; // 58% = 580
    dipDepthPctTenthsApprox: number; // ~10% = 100
  };
  /** "moving a stop to break-even after a +5% move was net negative in one study". */
  breakEvenStopAfterPlus5PctMove: {
    triggerMovePctTenths: number; // +5% = 50
    netNegativeInOneStudy: true;
  };
  /** "take-profit ladders capped winners needed to offset losses" (qualitative). */
  takeProfitLaddersCappedNeededWinners: true;
  /** "winners' first pullback averaged approximately 22 percentage points". */
  winnerFirstPullbackAvgPpTenthsApprox: number; // ~22pp = 220
  /** "97% of those winner pullbacks recovered". */
  winnerPullbackRecoveryPctTenths: number; // 97% = 970
  /** "losers' first pullback averaged approximately 38 percentage points". */
  loserFirstPullbackAvgPpTenthsApprox: number; // ~38pp = 380
  /** "loser pullbacks were approximately 1.7 times deeper" — ratio in tenths (1.7x = 17). */
  loserPullbackDepthRatioTenthsApprox: number;
  /** "only approximately 32% of loser pullbacks recovered". */
  loserPullbackRecoveryPctTenthsApprox: number; // ~32% = 320
  /** "winners and losers were difficult to separate in the first few seconds" (qualitative). */
  earlySecondsInseparable: true;
}

export const REDDIT_EXIT_PULLBACK_RECOVERY: SourceFixture<ExitPullbackRecoveryData> = {
  id: "reddit_exit_pullback_recovery_v1",
  title: "Reddit exit engineering: winner vs loser pullback depth and recovery",
  label: "SOURCE_CLAIM_UNVERIFIED",
  claimText:
    "Winners' first pullback averaged ~22pp and 97% recovered; losers' first pullback " +
    "averaged ~38pp (~1.7x deeper) and only ~32% recovered. 58% of eventual winners " +
    "first fell ~10%; trailing stops at every tested percentage cut winners; a " +
    "break-even stop after a +5% move was net negative in one study.",
  sourceRef: redditRef(
    "exit_pullback_recovery_claims",
    "## Exit-engineering result",
    { start: 327, end: 347 },
  ),
  data: {
    trailingStopsCutWinnersAtEveryTestedPct: true,
    winnersThatFirstFell: {
      shareOfWinnersPctTenths: 580,
      dipDepthPctTenthsApprox: 100,
    },
    breakEvenStopAfterPlus5PctMove: {
      triggerMovePctTenths: 50,
      netNegativeInOneStudy: true,
    },
    takeProfitLaddersCappedNeededWinners: true,
    winnerFirstPullbackAvgPpTenthsApprox: 220,
    winnerPullbackRecoveryPctTenths: 970,
    loserFirstPullbackAvgPpTenthsApprox: 380,
    loserPullbackDepthRatioTenthsApprox: 17,
    loserPullbackRecoveryPctTenthsApprox: 320,
    earlySecondsInseparable: true,
  },
};

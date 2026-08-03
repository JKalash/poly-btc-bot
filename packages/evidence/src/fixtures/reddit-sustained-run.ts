import { redditRef, type SourceFixture } from "./provenance";

/**
 * Sustained-trend (consecutive same-direction blocks) continuation table.
 *
 * Provenance: 2026-07-31-001-initial-refinement.fable,
 * "## Sustained-trend result", lines 247-266 (table lines 251-257).
 *
 * The source interprets the monotonic decline as mean reversion after stronger
 * and longer moves (line 259). Trading the inversion is NOT authorized: price
 * paid, fill process, and adverse selection are absent (lines 261-266).
 */

export interface SustainedRunRow {
  /** Trend filter exactly as printed. */
  filter: string;
  /** Minimum consecutive same-direction five-minute blocks. */
  minRunBlocks: number;
  /** Additional minimum cumulative move filter, parts-per-million (0.8% = 8000); null when absent. */
  minTotalMovePpm: number | null;
  n: number;
  /** Continuation win rate, tenths of a percent (48.4% = 484). */
  continuationWinRatePctTenths: number;
}

export interface SustainedRunData {
  blockIntervalMinutes: 5;
  /** Source's interpretation, preserved verbatim in spirit. */
  sourceInterpretation: string;
  rows: SustainedRunRow[];
}

export const REDDIT_SUSTAINED_RUN: SourceFixture<SustainedRunData> = {
  id: "reddit_sustained_run_v1",
  title: "Reddit sustained-trend continuation by run length (5-minute blocks)",
  label: "SOURCE_CLAIM_UNVERIFIED",
  claimText:
    "Continuation declines monotonically with run length: 48.4% after >=2 consecutive " +
    "same-direction 5-minute blocks (N=168,815) down to 44.8% after >=4 blocks with " +
    ">=0.8% total move (N=5,873) — interpreted as mean reversion after stronger, longer moves.",
  sourceRef: redditRef(
    "sustained_trend_continuation_table",
    "## Sustained-trend result",
    { start: 247, end: 266 },
  ),
  data: {
    blockIntervalMinutes: 5,
    sourceInterpretation:
      "Monotonic decline in continuation = mean reversion after stronger and longer moves.",
    rows: [
      { filter: "At least 2 consecutive same-direction five-minute blocks", minRunBlocks: 2, minTotalMovePpm: null, n: 168815, continuationWinRatePctTenths: 484 },
      { filter: "At least 3", minRunBlocks: 3, minTotalMovePpm: null, n: 81364, continuationWinRatePctTenths: 476 },
      { filter: "At least 4", minRunBlocks: 4, minTotalMovePpm: null, n: 38571, continuationWinRatePctTenths: 464 },
      { filter: "At least 5", minRunBlocks: 5, minTotalMovePpm: null, n: 17856, continuationWinRatePctTenths: 461 },
      { filter: "At least 4 and at least 0.8% total move", minRunBlocks: 4, minTotalMovePpm: 8000, n: 5873, continuationWinRatePctTenths: 448 },
    ],
  },
};

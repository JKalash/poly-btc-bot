import { redditRef, type SourceFixture } from "./provenance";

/**
 * Momentum / directional-continuation table (ETH one-minute candle study).
 *
 * Provenance: 2026-07-31-001-initial-refinement.fable,
 * "## Momentum and continuation result", lines 222-245 (table lines 235-239).
 *
 * The "Any" row is printed as "approximately 49.0%" — flagged `approx: true`.
 * This is an ETH candle study; the brief mandates BTC and ETH be reproduced
 * separately before any live use (lines 241-245).
 */

export interface MomentumContinuationRow {
  /** Filter label exactly as printed. */
  filter: string;
  /** Minimum prior move in parts-per-million of price (0.10% = 1000); null for "Any". */
  minPriorMovePpm: number | null;
  /** Continuation win rate, tenths of a percent (49.0% = 490). */
  continuationWinRatePctTenths: number;
  /** True when the source prefixes the value with "approximately". */
  approx: boolean;
}

export interface MomentumContinuationData {
  /** "346,094 windows". */
  windows: number;
  /** "1.73 million ETH one-minute bars" — exact bar count not printed. */
  claimedBarsAsPrinted: "1.73 million";
  asset: "ETH";
  barIntervalMinutes: 1;
  /** "approximately three years of data". */
  claimedYearsApprox: 3;
  /** Methodology as claimed: no lookahead; strike = window open; outcome = window close. */
  methodology: string;
  rows: MomentumContinuationRow[];
}

export const REDDIT_MOMENTUM_CONTINUATION: SourceFixture<MomentumContinuationData> = {
  id: "reddit_momentum_continuation_v1",
  title: "Reddit momentum/continuation rates over 346,094 ETH windows",
  label: "SOURCE_CLAIM_UNVERIFIED",
  claimText:
    "Directional continuation is at or below coin-flip and declines as the prior move " +
    "grows: ~49.0% unconditional, 48.0% after >=0.10%, 46.5% after >=0.40% — apparent " +
    "mean reversion, on ETH candles with strike = window open and outcome = window close.",
  sourceRef: redditRef(
    "momentum_continuation_table",
    "## Momentum and continuation result",
    { start: 222, end: 245 },
  ),
  data: {
    windows: 346094,
    claimedBarsAsPrinted: "1.73 million",
    asset: "ETH",
    barIntervalMinutes: 1,
    claimedYearsApprox: 3,
    methodology: "No lookahead; strike equal to the window open; outcome equal to the window close.",
    rows: [
      { filter: "Any", minPriorMovePpm: null, continuationWinRatePctTenths: 490, approx: true },
      { filter: "At least 0.10%", minPriorMovePpm: 1000, continuationWinRatePctTenths: 480, approx: false },
      { filter: "At least 0.40%", minPriorMovePpm: 4000, continuationWinRatePctTenths: 465, approx: false },
    ],
  },
};

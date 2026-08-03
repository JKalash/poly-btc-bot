import { redditRef, type SourceFixture } from "./provenance";

/**
 * Yearly reversal rates after a strong 20-minute run (mean-reversion caveat).
 *
 * Provenance: 2026-07-31-001-initial-refinement.fable,
 * "## Mean-reversion caveat", lines 451-471 (table lines 457-462).
 *
 * The source's ONLY directional hypothesis with a claimed faint positive
 * signal. The weak 2024 rate (51.6%) is a required stability warning, not a
 * row to omit (line 471). The brief maps this to `extended_move_fade_v1`, a
 * disabled, non-live research hypothesis (lines 468-470). "Strong" run is not
 * quantified by the source.
 */

export interface YearlyReversalRateRow {
  year: number;
  /** Reversal rate, tenths of a percent (53.8% = 538). */
  reversalRatePctTenths: number;
}

export interface YearlyReversalRatesData {
  /** Conditioning context claimed by the source ("strong" is not quantified). */
  condition: "after a strong 20-minute run";
  runLengthMinutes: 20;
  /** Source framing: ~4-point paper edge at a 0.50 zero-fee maker price. */
  framedPaperEdgePpApprox: number;
  framedAtMakerPriceCents: 50;
  /** The source explicitly states real maker fills and adverse selection were not proven. */
  makerFillsProven: false;
  /** Brief-assigned hypothesis id; disabled and not live-eligible. */
  hypothesisId: "extended_move_fade_v1";
  rows: YearlyReversalRateRow[];
}

export const REDDIT_YEARLY_REVERSAL_RATES: SourceFixture<YearlyReversalRatesData> = {
  id: "reddit_yearly_reversal_rates_v1",
  title: "Reddit yearly reversal rates after a strong 20-minute run",
  label: "SOURCE_CLAIM_UNVERIFIED",
  claimText:
    "After a strong 20-minute run, reversal rates by year: 2023 53.8%, 2024 51.6%, " +
    "2025 54.5%, 2026 54.6% — framed as ~4pp paper edge at a 0.50 zero-fee maker " +
    "price, with real maker fills and adverse selection explicitly not proven.",
  sourceRef: redditRef(
    "yearly_reversal_rates_table",
    "## Mean-reversion caveat",
    { start: 451, end: 471 },
  ),
  data: {
    condition: "after a strong 20-minute run",
    runLengthMinutes: 20,
    framedPaperEdgePpApprox: 4,
    framedAtMakerPriceCents: 50,
    makerFillsProven: false,
    hypothesisId: "extended_move_fade_v1",
    rows: [
      { year: 2023, reversalRatePctTenths: 538 },
      { year: 2024, reversalRatePctTenths: 516 },
      { year: 2025, reversalRatePctTenths: 545 },
      { year: 2026, reversalRatePctTenths: 546 },
    ],
  },
};

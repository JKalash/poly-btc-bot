import { gistRef, type SourceFixture } from "./provenance";

/**
 * Archetapp gist dry-run synthetic delta->token-price curve.
 *
 * Provenance: 2026-07-31-001-initial-refinement.fable,
 * "## Gist dry-run pricing and scoring", lines 723-749 (table lines 727-733).
 *
 * SYNTHETIC PRICING BASELINE — NOT EXECUTABLE (mandated UI label). This is the
 * gist's simulated token-price curve for dry runs, never a fill model. Primary
 * paper/backtest execution must replay captured Polymarket books (lines
 * 744-749). Anchors are qualitative ("below"/"around"/"at least") exactly as
 * printed; the top anchor is a price RANGE (0.92–0.97).
 */

export type CurveAnchorKind = "below" | "around" | "at_least";

export interface SyntheticCurveAnchor {
  /** Absolute window delta exactly as printed. */
  asPrinted: string;
  kind: CurveAnchorKind;
  /** Anchor delta in parts-per-million of price (0.005% = 50). */
  absWindowDeltaPpm: number;
  /** Simulated token price, cents. For the range row this is the lower bound. */
  priceMinCents: number;
  /** Upper bound in cents; equals priceMinCents for point anchors. */
  priceMaxCents: number;
}

export interface GistSyntheticDeltaCurveData {
  /** Mandated display label whenever this curve is shown or used. */
  mandatoryLabel: "Synthetic pricing baseline — not executable.";
  anchors: SyntheticCurveAnchor[];
  dryRunMethodology: {
    usesLiveBinanceAroundSecondsBeforeClose: 10;
    scoresOutcomeUsing: "Binance";
    /** Bankroll resets after falling below minimum so data collection continues (must not erase ruin). */
    bankrollResetsBelowMinimum: true;
  };
}

export const GIST_SYNTHETIC_DELTA_CURVE: SourceFixture<GistSyntheticDeltaCurveData> = {
  id: "gist_synthetic_delta_curve_v1",
  title: "Archetapp gist synthetic delta-to-price curve (dry-run baseline)",
  label: "SOURCE_CLAIM_UNVERIFIED",
  claimText:
    "Simulated favored-token price as a function of absolute window delta: <0.005% -> " +
    "0.50, ~0.02% -> 0.55, ~0.05% -> 0.65, ~0.10% -> 0.80, >=0.15% -> 0.92–0.97. A dry-run " +
    "convenience curve, not an executable or realistic fill model.",
  sourceRef: gistRef(
    "synthetic_delta_price_curve",
    "## Gist dry-run pricing and scoring",
    { start: 723, end: 749 },
  ),
  data: {
    mandatoryLabel: "Synthetic pricing baseline — not executable.",
    anchors: [
      { asPrinted: "Below 0.005%", kind: "below", absWindowDeltaPpm: 50, priceMinCents: 50, priceMaxCents: 50 },
      { asPrinted: "Around 0.02%", kind: "around", absWindowDeltaPpm: 200, priceMinCents: 55, priceMaxCents: 55 },
      { asPrinted: "Around 0.05%", kind: "around", absWindowDeltaPpm: 500, priceMinCents: 65, priceMaxCents: 65 },
      { asPrinted: "Around 0.10%", kind: "around", absWindowDeltaPpm: 1000, priceMinCents: 80, priceMaxCents: 80 },
      { asPrinted: "At least 0.15%", kind: "at_least", absWindowDeltaPpm: 1500, priceMinCents: 92, priceMaxCents: 97 },
    ],
    dryRunMethodology: {
      usesLiveBinanceAroundSecondsBeforeClose: 10,
      scoresOutcomeUsing: "Binance",
      bankrollResetsBelowMinimum: true,
    },
  },
};

import { redditRef, type SourceFixture } from "./provenance";

/**
 * Trend-side price bands within a confirmed 30-minute trend.
 *
 * Provenance: 2026-07-31-001-initial-refinement.fable,
 * "## Trend-side price result", lines 293-310 (table lines 297-302; the brief
 * notes at line 304 that "the counts reconcile to 1,262").
 */

export interface TrendSideBandRow {
  /** Band label exactly as printed. */
  band: string;
  /** Price paid for trend-direction side, band lower bound in cents. */
  priceMinCents: number;
  /** Band upper bound in cents. */
  priceMaxCents: number;
  n: number;
  /** Win rate, tenths of a percent (30.8% = 308). */
  winRatePctTenths: number;
}

export interface TrendSideBandsData {
  /** "1,262 real decisions" — reconciles with the row counts. */
  claimedDecisions: number;
  /** Conditioning context claimed by the source. */
  condition: string;
  rows: TrendSideBandRow[];
}

export const REDDIT_TREND_SIDE_BANDS: SourceFixture<TrendSideBandsData> = {
  id: "reddit_trend_side_bands_v1",
  title: "Reddit trend-side price bands within a confirmed 30-minute trend (1,262 decisions)",
  label: "SOURCE_CLAIM_UNVERIFIED",
  claimText:
    "Within a confirmed 30-minute trend, cheap trend-side tokens win far less often than " +
    "their price discount suggests: 0.00–0.45 wins 30.8%, 0.70–1.00 wins 84.2%. " +
    "Cheapness is not a discount without a probability estimate exceeding price plus friction.",
  sourceRef: redditRef(
    "trend_side_price_bands_table",
    "## Trend-side price result",
    { start: 293, end: 310 },
  ),
  data: {
    claimedDecisions: 1262,
    condition: "Within a confirmed 30-minute trend; price paid for the trend-direction side.",
    rows: [
      { band: "0.00–0.45", priceMinCents: 0, priceMaxCents: 45, n: 559, winRatePctTenths: 308 },
      { band: "0.45–0.55", priceMinCents: 45, priceMaxCents: 55, n: 175, winRatePctTenths: 429 },
      { band: "0.55–0.70", priceMinCents: 55, priceMaxCents: 70, n: 263, winRatePctTenths: 586 },
      { band: "0.70–1.00", priceMinCents: 70, priceMaxCents: 100, n: 265, winRatePctTenths: 842 },
    ],
  },
};

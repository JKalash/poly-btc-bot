import { gistRef, type SourceFixture } from "./provenance";

/**
 * Archetapp gist sizing modes: safe / aggressive / degen.
 *
 * Provenance: 2026-07-31-001-initial-refinement.fable,
 * "## Gist modes", lines 642-681 (Safe 646-656, Aggressive 658-664,
 * Degen 666-673, required interpretation 675-681).
 *
 * These exist ONLY as source fixtures for the Risk Lab. None is an executable
 * live profile:
 *  - "Safe" risks 25% of bankroll per trade; four consecutive losses lose
 *     exactly 1 - 0.75^4 = 0.68359375 of bankroll (brief line 654) — the label
 *     is misleading under the parent risk vocabulary and requires a warning.
 *  - "Aggressive" has a self-contradictory sizing description (risks "all
 *     proceeds"/profits, yet the first trade risks the original bankroll).
 *  - "Degen" is all-in every trade, never skips — a prohibited anti-pattern.
 * Regression tests elsewhere must prove no source mode can override the
 * absolute safety cap (brief line 681).
 *
 * Risk fractions are exact rationals (bigint numerator/denominator), following
 * the repo's no-float-money convention: bankroll sizing is money math.
 */

export interface GistModeSafe {
  name: "safe";
  /** 25% of bankroll per trade, as an exact rational (1/4). */
  riskPerTrade: { numerator: bigint; denominator: bigint };
  /** Minimum score confidence, tenths of a percent (30% = 300). */
  minScoreConfidencePctTenths: 300;
  /** Source claims four consecutive losses reduce bankroll by "approximately 68%". */
  claimedFourLossDrawdownAsPrinted: "approximately 68%";
  /** Brief's exact arithmetic: 1 - 0.75^4 = 0.68359375. */
  briefExactFourLossDrawdownAsPrinted: "0.68359375";
  /** "This is not safe under the parent risk vocabulary" — mandated warning. */
  labelMisleading: true;
}

export interface GistModeAggressive {
  name: "aggressive";
  /** Minimum confidence, tenths of a percent (20% = 200). */
  minScoreConfidencePctTenths: 200;
  /** Described as risking "all proceeds" or profits above original investment. */
  risksAllProceedsAsDescribed: true;
  /** Also says the first trade risks the original bankroll and later protects the original. */
  firstTradeRisksOriginalBankroll: true;
  /** The two descriptions conflict; can still produce catastrophic exposure. */
  descriptionAmbiguous: true;
  liveProfileProhibited: true;
}

export interface GistModeDegen {
  name: "degen";
  /** All-in every trade: risk fraction exactly 1/1. */
  riskPerTrade: { numerator: bigint; denominator: bigint };
  /** Minimum confidence zero. */
  minScoreConfidencePctTenths: 0;
  neverSkips: true;
  /** Explicitly accepts frequent ruin for streak-based compounding. */
  acceptsFrequentRuin: true;
  /** Brief classification: "This is a prohibited anti-pattern." */
  prohibitedAntiPattern: true;
}

export interface GistModesData {
  safe: GistModeSafe;
  aggressive: GistModeAggressive;
  degen: GistModeDegen;
  /** None of these may become executable; parent capped profiles retain their meanings. */
  executableLive: false;
}

export const GIST_MODES: SourceFixture<GistModesData> = {
  id: "gist_modes_v1",
  title: "Archetapp gist sizing modes: safe (25%/trade), aggressive, degen (all-in)",
  label: "SOURCE_CLAIM_UNVERIFIED",
  claimText:
    "Three modes: 'Safe' risks 25% of bankroll per trade at >=30% score confidence " +
    "(four consecutive losses lose ~68% of bankroll); 'Aggressive' risks proceeds at " +
    ">=20% confidence with a self-contradictory first-trade description; 'Degen' goes " +
    "all-in every trade at zero confidence and never skips.",
  sourceRef: gistRef("gist_modes_sizing", "## Gist modes", { start: 642, end: 681 }),
  data: {
    safe: {
      name: "safe",
      riskPerTrade: { numerator: 1n, denominator: 4n },
      minScoreConfidencePctTenths: 300,
      claimedFourLossDrawdownAsPrinted: "approximately 68%",
      briefExactFourLossDrawdownAsPrinted: "0.68359375",
      labelMisleading: true,
    },
    aggressive: {
      name: "aggressive",
      minScoreConfidencePctTenths: 200,
      risksAllProceedsAsDescribed: true,
      firstTradeRisksOriginalBankroll: true,
      descriptionAmbiguous: true,
      liveProfileProhibited: true,
    },
    degen: {
      name: "degen",
      riskPerTrade: { numerator: 1n, denominator: 1n },
      minScoreConfidencePctTenths: 0,
      neverSkips: true,
      acceptsFrequentRuin: true,
      prohibitedAntiPattern: true,
    },
    executableLive: false,
  },
};

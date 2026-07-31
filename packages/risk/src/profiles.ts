import { ppm, prob, type RiskLimits } from "@b5p/domain";

export type RiskProfileName = "paper_exploration" | "aggressive" | "very_aggressive" | "custom";

/**
 * ABSOLUTE SAFETY CAP — per-market risk can never exceed 10% of bankroll in
 * this release, regardless of profile or custom configuration. Changing this
 * requires a source change plus updating the tests that pin it.
 */
export const ABSOLUTE_MAX_RISK_PPM = ppm("0.10");

export const RISK_PROFILES: Record<Exclude<RiskProfileName, "custom">, RiskLimits> = {
  /** No economic limit (simulated funds), but equivalent risk is displayed. Live is never allowed. */
  paper_exploration: {
    baseRiskFractionPpm: ppm("0.02"),
    maxRiskFractionPpm: ppm("1.0"),
    sessionLossLimitPpm: ppm("1.0"),
    dailyLossLimitPpm: ppm("1.0"),
    consecutiveLossLimit: 1_000_000,
    maxOpenPositions: 1,
    kellyMultiplierPpm: ppm("0.25"),
    livePriceCeiling: prob("0.99"),
    liveEntryCutoffSeconds: 60,
    paperEntryCutoffSeconds: 15,
    minConservativeEdgePpm: ppm("0.02"),
    minExpectedValuePerCostPpm: ppm("0.01"),
    maxSpread: prob("0.02"),
    maxPriceImpact: prob("0.005"),
    liveAllowed: false,
  },
  aggressive: {
    baseRiskFractionPpm: ppm("0.02"),
    maxRiskFractionPpm: ppm("0.05"),
    sessionLossLimitPpm: ppm("0.08"),
    dailyLossLimitPpm: ppm("0.12"),
    consecutiveLossLimit: 3,
    maxOpenPositions: 1,
    kellyMultiplierPpm: ppm("0.25"),
    livePriceCeiling: prob("0.90"),
    liveEntryCutoffSeconds: 60,
    paperEntryCutoffSeconds: 15,
    minConservativeEdgePpm: ppm("0.02"),
    minExpectedValuePerCostPpm: ppm("0.01"),
    maxSpread: prob("0.02"),
    maxPriceImpact: prob("0.005"),
    liveAllowed: true,
  },
  /**
   * Exists because the operator explicitly requested very aggressive behavior.
   * A 10% stake is genuinely extreme: five full losses leave ~59% of starting
   * capital, ten leave ~35%. The UI must display this before activation.
   */
  very_aggressive: {
    baseRiskFractionPpm: ppm("0.05"),
    maxRiskFractionPpm: ppm("0.10"),
    sessionLossLimitPpm: ppm("0.15"),
    dailyLossLimitPpm: ppm("0.20"),
    consecutiveLossLimit: 2,
    maxOpenPositions: 1,
    kellyMultiplierPpm: ppm("0.50"),
    livePriceCeiling: prob("0.90"),
    liveEntryCutoffSeconds: 60,
    paperEntryCutoffSeconds: 15,
    minConservativeEdgePpm: ppm("0.02"),
    minExpectedValuePerCostPpm: ppm("0.01"),
    maxSpread: prob("0.02"),
    maxPriceImpact: prob("0.005"),
    liveAllowed: true,
  },
};

/** Custom profiles clamp to the absolute cap; there is deliberately no "all in" configuration. */
export function clampCustomProfile(limits: RiskLimits): { limits: RiskLimits; clamped: boolean } {
  let clamped = false;
  const out = { ...limits };
  if (out.maxRiskFractionPpm > ABSOLUTE_MAX_RISK_PPM) {
    out.maxRiskFractionPpm = ABSOLUTE_MAX_RISK_PPM;
    clamped = true;
  }
  if (out.baseRiskFractionPpm > out.maxRiskFractionPpm) {
    out.baseRiskFractionPpm = out.maxRiskFractionPpm;
    clamped = true;
  }
  return { limits: out, clamped };
}

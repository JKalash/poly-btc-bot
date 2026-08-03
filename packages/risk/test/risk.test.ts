import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ppm, prob, usdc, toNumber, PPM, mulDiv } from "@b5p/domain";
import {
  ABSOLUTE_MAX_RISK_PPM, RISK_PROFILES, clampCustomProfile,
  computeSizing, evaluateOrderRisk, type RiskContext,
} from "../src/index";

/** A context that passes every gate — each test breaks exactly one thing. */
function healthyCtx(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    mode: "paper",
    engineArmedForMode: true,
    limits: RISK_PROFILES.very_aggressive,
    profileName: "very_aggressive",
    bankroll: {
      bankroll: usdc("1000"),
      sessionPeak: usdc("1000"),
      dailyPeak: usdc("1000"),
      sessionRealized: 0n,
      dailyRealized: 0n,
      consecutiveLosses: 0,
      openPositions: 0,
      openExposure: 0n,
      reconciled: true,
    },
    chainlinkAgeMs: 500,
    chainlinkMaxAgeMs: 1500,
    bookAgeMs: 300,
    bookMaxAgeMs: 1000,
    clockSkewMs: 10,
    clockMaxDriftMs: 100,
    priceToBeatKnown: true,
    priceToBeatConsistent: true,
    rulesVerified: true,
    feeScheduleKnown: true,
    dataQualityScore: 1,
    minDataQuality: 0.8,
    style: "maker_post_only",
    takerPermittedByStrategy: false,
    price: prob("0.55"),
    bestBidSameSide: prob("0.54"),
    bestAskSameSide: prob("0.56"),
    spread: prob("0.02"),
    estimatedImpact: prob("0.001"),
    secondsRemaining: 90,
    conservativeProbability: prob("0.60"),
    feeSchedule: { ratePpm: ppm("0.07"), collection: "usdc" },
    modelApprovedForMode: true,
    calibrationRequired: true,
    modelCalibrated: true,
    strategyValidatedForMode: true,
    coolingOffUntilMs: null,
    nowMs: 1_000_000,
    idempotencyKeyIsDuplicate: false,
    requestedStakeFractionPpm: null,
    minOrderStake6: usdc("1"),
    ...overrides,
  };
}

describe("risk approval", () => {
  it("approves a healthy maker candidate", () => {
    const v = evaluateOrderRisk(healthyCtx());
    expect(v.reasons).toEqual([]);
    expect(v.approved).toBe(true);
    expect(v.sizing!.stake6 > 0n).toBe(true);
  });
});

describe("hard rejection rules — each fires with a human-readable reason", () => {
  const cases: Array<[string, Partial<RiskContext>, string]> = [
    ["not armed", { engineArmedForMode: false }, "ENGINE_NOT_ARMED"],
    ["chainlink stale", { chainlinkAgeMs: 5000 }, "CHAINLINK_STALE"],
    ["chainlink missing", { chainlinkAgeMs: null }, "CHAINLINK_STALE"],
    ["book stale", { bookAgeMs: 2000 }, "BOOK_STALE"],
    ["clock drift", { clockSkewMs: 500 }, "CLOCK_DRIFT_EXCEEDED"],
    ["clock unknown", { clockSkewMs: null }, "CLOCK_DRIFT_EXCEEDED"],
    ["price-to-beat unknown", { priceToBeatKnown: false }, "PRICE_TO_BEAT_UNKNOWN"],
    ["price-to-beat mismatch", { priceToBeatConsistent: false }, "PRICE_TO_BEAT_MISMATCH"],
    ["rules unverified", { rulesVerified: false }, "RULES_UNVERIFIED"],
    ["fee unknown", { feeScheduleKnown: false }, "FEE_SCHEDULE_UNKNOWN"],
    ["bankroll unreconciled", { bankroll: { ...healthyCtx().bankroll, reconciled: false } }, "BANKROLL_UNRECONCILED"],
    ["concurrency", { bankroll: { ...healthyCtx().bankroll, openPositions: 1 } }, "CONCURRENCY_LIMIT"],
    ["consecutive losses (very aggressive stops at 2)", { bankroll: { ...healthyCtx().bankroll, consecutiveLosses: 2 } }, "CONSECUTIVE_LOSS_STOP"],
    ["session stop", { bankroll: { ...healthyCtx().bankroll, bankroll: usdc("850"), sessionPeak: usdc("1000"), dailyPeak: usdc("1000") } }, "SESSION_LOSS_STOP"],
    ["daily stop", { bankroll: { ...healthyCtx().bankroll, bankroll: usdc("790"), sessionPeak: usdc("790"), dailyPeak: usdc("1000") } }, "DAILY_LOSS_STOP"],
    ["cutoff", { secondsRemaining: 10 }, "PAST_ENTRY_CUTOFF"],
    ["taker not permitted", { style: "taker_fok" }, "TAKER_NOT_PERMITTED"],
    ["no edge", { conservativeProbability: prob("0.55") }, "INSUFFICIENT_EDGE"],
    ["insufficient EV when the EV knob exceeds the edge knob", { limits: { ...RISK_PROFILES.very_aggressive, minExpectedValuePerCostPpm: ppm("0.20") } }, "INSUFFICIENT_EV"],
    ["spread", { spread: prob("0.05") }, "SPREAD_TOO_WIDE"],
    ["impact", { estimatedImpact: prob("0.01") }, "IMPACT_TOO_HIGH"],
    ["taker impact unknown fails closed", { style: "taker_fok", takerPermittedByStrategy: true, estimatedImpact: null, conservativeProbability: prob("0.65") }, "IMPACT_UNKNOWN"],
    ["post-only would cross", { price: prob("0.56"), conservativeProbability: prob("0.62") }, "POST_ONLY_WOULD_CROSS"],
    ["data quality", { dataQualityScore: 0.5 }, "DATA_QUALITY_LOW"],
    ["model not approved", { modelApprovedForMode: false }, "MODEL_NOT_APPROVED"],
    ["uncalibrated model while calibration required", { modelCalibrated: false }, "MODEL_UNCALIBRATED"],
    ["strategy unvalidated", { strategyValidatedForMode: false }, "STRATEGY_UNVALIDATED"],
    ["cooling off", { coolingOffUntilMs: 2_000_000 }, "COOLING_OFF_ACTIVE"],
    ["duplicate idempotency", { idempotencyKeyIsDuplicate: true }, "DUPLICATE_IDEMPOTENCY_KEY"],
    ["stake above cap", { requestedStakeFractionPpm: ppm("0.19") }, "STAKE_EXCEEDS_CAP"],
  ];

  for (const [name, overrides, code] of cases) {
    it(`rejects: ${name}`, () => {
      const v = evaluateOrderRisk(healthyCtx(overrides));
      expect(v.approved).toBe(false);
      expect(v.reasons.map((x) => x.code)).toContain(code);
      for (const reason of v.reasons) expect(reason.message.length).toBeGreaterThan(10);
    });
  }

  it("maker orders legitimately carry no impact estimate — null impact approves", () => {
    const v = evaluateOrderRisk(healthyCtx({ estimatedImpact: null }));
    expect(v.reasons.map((x) => x.code)).not.toContain("IMPACT_UNKNOWN");
    expect(v.approved).toBe(true);
  });

  it("uncalibrated model is allowed only when calibration_required is explicitly false", () => {
    const v = evaluateOrderRisk(healthyCtx({ calibrationRequired: false, modelCalibrated: false }));
    expect(v.reasons.map((x) => x.code)).not.toContain("MODEL_UNCALIBRATED");
    expect(v.approved).toBe(true);
  });

  it("calibration_required holds in live mode too (no arming bypass)", () => {
    const v = evaluateOrderRisk(healthyCtx({ mode: "live", limits: RISK_PROFILES.very_aggressive, modelCalibrated: false }));
    expect(v.reasons.map((x) => x.code)).toContain("MODEL_UNCALIBRATED");
  });

  it("live mode is rejected when profile disallows live", () => {
    const v = evaluateOrderRisk(healthyCtx({ mode: "live", limits: RISK_PROFILES.paper_exploration, profileName: "paper_exploration" }));
    expect(v.approved).toBe(false);
    expect(v.reasons.map((x) => x.code)).toContain("ENGINE_NOT_ARMED");
  });

  it("live price ceiling applies in live mode only", () => {
    const at95 = { price: prob("0.95"), bestAskSameSide: prob("0.97"), conservativeProbability: prob("0.99") };
    expect(evaluateOrderRisk(healthyCtx(at95)).reasons.map((x) => x.code)).not.toContain("PRICE_ABOVE_CEILING");
    const live = evaluateOrderRisk(healthyCtx({ ...at95, mode: "live" }));
    expect(live.reasons.map((x) => x.code)).toContain("PRICE_ABOVE_CEILING");
  });
});

describe("sizing and caps", () => {
  it("very-aggressive cap holds: 19% request is cut to 10%", () => {
    const s = computeSizing(healthyCtx({ requestedStakeFractionPpm: ppm("0.19") }));
    expect(s.fractionPpm).toBe(ppm("0.10"));
    expect(s.capResult.binding).toBe("profile_max_per_market");
    expect(s.stake6).toBe(usdc("100"));
  });

  it("absolute 10% cap binds inside the evaluator even with unclamped caller limits", () => {
    const s = computeSizing(healthyCtx({
      limits: { ...RISK_PROFILES.very_aggressive, maxRiskFractionPpm: ppm("0.50") },
      requestedStakeFractionPpm: ppm("0.50"),
    }));
    expect(s.fractionPpm).toBe(ABSOLUTE_MAX_RISK_PPM);
    expect(s.capResult.binding).toBe("absolute_max");
    expect(s.stake6).toBe(usdc("100"));
  });

  it("session budget shrinks available stake after losses", () => {
    const s = computeSizing(healthyCtx({
      requestedStakeFractionPpm: ppm("0.10"),
      bankroll: { ...healthyCtx().bankroll, bankroll: usdc("900"), sessionPeak: usdc("1000"), dailyPeak: usdc("1000") },
    }));
    // session budget = 15% of 1000 - 100 lost = 50 -> fraction of current bankroll 50/900
    expect(s.capResult.binding).toBe("session_remaining_budget");
    expect(toNumber(s.stake6)).toBeCloseTo(50, 0);
  });

  it("kelly can shrink but never inflate the base fraction", () => {
    const tinyEdge = computeSizing(healthyCtx({ conservativeProbability: prob("0.56") }));
    expect(tinyEdge.fractionPpm < RISK_PROFILES.very_aggressive.baseRiskFractionPpm).toBe(true);
    const hugeEdge = computeSizing(healthyCtx({ conservativeProbability: prob("0.90") }));
    expect(hugeEdge.fractionPpm <= RISK_PROFILES.very_aggressive.baseRiskFractionPpm).toBe(true);
  });

  it("property: stake never exceeds any cap for any inputs", () => {
    fc.assert(
      fc.property(
        fc.bigInt(1_000_000n, 100_000_000_000n), // bankroll 1..100k USDC
        fc.bigInt(0n, 1_000_000n),               // requested fraction
        fc.bigInt(500_000n, 999_000n),           // conservative prob .5-.999
        fc.bigInt(10_000n, 990_000n),            // price
        (bank, req, q, p) => {
          const s = computeSizing(healthyCtx({
            bankroll: { ...healthyCtx().bankroll, bankroll: bank, sessionPeak: bank, dailyPeak: bank },
            requestedStakeFractionPpm: req,
            conservativeProbability: q,
            price: p,
          }));
          const capOk = s.fractionPpm <= RISK_PROFILES.very_aggressive.maxRiskFractionPpm && s.fractionPpm <= req;
          const stakeOk = s.stake6 <= mulDiv(bank, s.fractionPpm, PPM, "ceil");
          return capOk && stakeOk;
        },
      ),
    );
  });
});

describe("profiles", () => {
  it("absolute cap is 10% and custom profiles clamp to it", () => {
    expect(ABSOLUTE_MAX_RISK_PPM).toBe(ppm("0.10"));
    const { limits, clamped } = clampCustomProfile({
      ...RISK_PROFILES.very_aggressive,
      maxRiskFractionPpm: ppm("0.50"),
      baseRiskFractionPpm: ppm("0.25"),
    });
    expect(clamped).toBe(true);
    expect(limits.maxRiskFractionPpm).toBe(ppm("0.10"));
    expect(limits.baseRiskFractionPpm).toBe(ppm("0.10"));
  });

  it("paper exploration never allows live", () => {
    expect(RISK_PROFILES.paper_exploration.liveAllowed).toBe(false);
  });

  it("built-in profiles are frozen against mutation", () => {
    expect(Object.isFrozen(RISK_PROFILES)).toBe(true);
    for (const p of Object.values(RISK_PROFILES)) expect(Object.isFrozen(p)).toBe(true);
    expect(() => { (RISK_PROFILES.very_aggressive as { maxRiskFractionPpm: bigint }).maxRiskFractionPpm = ppm("0.50"); }).toThrow();
    expect(RISK_PROFILES.very_aggressive.maxRiskFractionPpm).toBe(ppm("0.10"));
  });

  it("custom loss stops clamp to the most aggressive built-in profile", () => {
    const { limits, clamped } = clampCustomProfile({
      ...RISK_PROFILES.very_aggressive,
      sessionLossLimitPpm: ppm("1.0"),
      dailyLossLimitPpm: ppm("1.0"),
    });
    expect(clamped).toBe(true);
    expect(limits.sessionLossLimitPpm).toBe(RISK_PROFILES.very_aggressive.sessionLossLimitPpm);
    expect(limits.dailyLossLimitPpm).toBe(RISK_PROFILES.very_aggressive.dailyLossLimitPpm);
  });

  it("spec profile numbers", () => {
    const va = RISK_PROFILES.very_aggressive;
    expect(toNumber(va.baseRiskFractionPpm)).toBe(0.05);
    expect(toNumber(va.maxRiskFractionPpm)).toBe(0.10);
    expect(toNumber(va.sessionLossLimitPpm)).toBe(0.15);
    expect(toNumber(va.dailyLossLimitPpm)).toBe(0.20);
    expect(va.consecutiveLossLimit).toBe(2);
    const ag = RISK_PROFILES.aggressive;
    expect(toNumber(ag.baseRiskFractionPpm)).toBe(0.02);
    expect(toNumber(ag.maxRiskFractionPpm)).toBe(0.05);
    expect(ag.consecutiveLossLimit).toBe(3);
  });
});

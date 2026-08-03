import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ppm, prob, shares, usdc, toNumber } from "@b5p/domain";
import {
  ABSOLUTE_MAX_RISK_PPM, DEFAULT_INVENTORY_RISK_LIMITS, INVENTORY_HARD_REJECT_CODES,
  RISK_PROFILES, deriveCycleFacts, derivePendingCtfValue6, evaluateInventoryRisk,
  evaluateOrderRisk, type InventoryRiskContext, type RiskContext,
} from "../src/index";

/**
 * An inventory context that passes every gate — each test perturbs one thing.
 * Honest QUOTING_BOTH baseline: both legs resting (open) but symmetric, so no
 * directional exposure and no risk-free claim.
 */
function healthyInventory(overrides: Partial<InventoryRiskContext> = {}): InventoryRiskContext {
  return {
    limits: DEFAULT_INVENTORY_RISK_LIMITS,
    mode: "paper",
    bankroll6: usdc("1000"),
    cycleState: "QUOTING_BOTH",
    labeledRiskFree: false,
    computedRiskFree: false,
    hasOpenLeg: true,
    hasUnhedgedFills: false,
    oneLegOpenMs: null,
    unhedgedExposure6: 0n,
    attemptsForIntent: 0,
    cancelUncertaintyMs: null,
    pendingCtfValue6: usdc("10"),
    upInventory6: shares("50"),
    downInventory6: shares("50"),
    dailyOperationalLoss6: 0n,
    isSourceReproductionStrategy: false,
    sourceClaimAllocation6: 0n,
    evExcludingUnpaidIncentivesPpm: ppm("0.01"),
    evIncludingUnpaidIncentivesPpm: ppm("0.02"),
    ...overrides,
  };
}

/** Same healthy directional baseline as risk.test.ts. */
function healthyCtx(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    mode: "paper",
    engineArmedForMode: true,
    limits: RISK_PROFILES.very_aggressive,
    profileName: "very_aggressive",
    bankroll: {
      bankroll: usdc("1000"), sessionPeak: usdc("1000"), dailyPeak: usdc("1000"),
      sessionRealized: 0n, dailyRealized: 0n, consecutiveLosses: 0,
      openPositions: 0, openExposure: 0n, reconciled: true,
    },
    chainlinkAgeMs: 500, chainlinkMaxAgeMs: 1500,
    bookAgeMs: 300, bookMaxAgeMs: 1000,
    clockSkewMs: 10, clockMaxDriftMs: 100,
    priceToBeatKnown: true, priceToBeatConsistent: true,
    rulesVerified: true, feeScheduleKnown: true,
    dataQualityScore: 1, minDataQuality: 0.8,
    style: "maker_post_only", takerPermittedByStrategy: false,
    price: prob("0.55"), bestBidSameSide: prob("0.54"), bestAskSameSide: prob("0.56"),
    spread: prob("0.02"), estimatedImpact: prob("0.001"),
    secondsRemaining: 90,
    conservativeProbability: prob("0.60"),
    feeSchedule: { ratePpm: ppm("0.07"), collection: "usdc" },
    modelApprovedForMode: true, calibrationRequired: true, modelCalibrated: true,
    strategyValidatedForMode: true,
    coolingOffUntilMs: null, nowMs: 1_000_000,
    idempotencyKeyIsDuplicate: false,
    requestedStakeFractionPpm: null, minOrderStake6: usdc("1"),
    ...overrides,
  };
}

describe("inventory risk approval", () => {
  it("approves a healthy paired-quoting context with no reasons", () => {
    const v = evaluateInventoryRisk(healthyInventory());
    expect(v.reasons).toEqual([]);
    expect(v.approved).toBe(true);
  });

  it("brief defaults are pinned: 1% unhedged, 2s one-leg, 1 attempt per intent", () => {
    expect(toNumber(DEFAULT_INVENTORY_RISK_LIMITS.maxUnhedgedRiskFractionPpm)).toBe(0.01);
    expect(DEFAULT_INVENTORY_RISK_LIMITS.maxOneLegDurationMs).toBe(2000);
    expect(DEFAULT_INVENTORY_RISK_LIMITS.maxAttemptsPerIntent).toBe(1);
  });

  it("deriveCycleFacts: symmetric QUOTING_BOTH legs are open but not directional exposure", () => {
    const facts = deriveCycleFacts(
      { state: "QUOTING_BOTH", worstCaseLoss6: usdc("25"), oneLegFilledAtMs: null, unhedgedDurationMs: null },
      [{ state: "QUOTED", unhedgedStartedAtMs: null }, { state: "QUOTED", unhedgedStartedAtMs: null }],
      10_000,
    );
    expect(facts.hasOpenLeg).toBe(true);
    expect(facts.hasUnhedgedFills).toBe(false);
    expect(facts.oneLegOpenMs).toBe(null);
    expect(facts.unhedgedExposure6).toBe(0n);
    expect(facts.computedRiskFree).toBe(false);
  });

  it("deriveCycleFacts: one-sided fill carries duration and the worst-case-loss exposure", () => {
    const facts = deriveCycleFacts(
      { state: "ONE_LEG_FILLED", worstCaseLoss6: usdc("25"), oneLegFilledAtMs: 4_000, unhedgedDurationMs: null },
      [{ state: "UNHEDGED", unhedgedStartedAtMs: 5_000 }, { state: "QUOTED", unhedgedStartedAtMs: null }],
      10_000,
    );
    expect(facts.hasUnhedgedFills).toBe(true);
    expect(facts.oneLegOpenMs).toBe(6_000); // earliest known stamp (cycle's 4000)
    expect(facts.unhedgedExposure6).toBe(usdc("25"));
    expect(facts.computedRiskFree).toBe(false);
  });

  it("deriveCycleFacts: accumulated unhedgedDurationMs wins when it exceeds the live episode age", () => {
    const facts = deriveCycleFacts(
      { state: "ONE_LEG_FILLED", worstCaseLoss6: usdc("25"), oneLegFilledAtMs: 9_500, unhedgedDurationMs: 7_000 },
      [{ state: "UNHEDGED", unhedgedStartedAtMs: 9_500 }],
      10_000,
    );
    expect(facts.oneLegOpenMs).toBe(7_000); // max(cumulative 7000, age 500)
  });

  it("deriveCycleFacts: exposure with NO known duration yields null (which the gate rejects)", () => {
    const facts = deriveCycleFacts(
      { state: "HEDGE_OR_CANCEL", worstCaseLoss6: usdc("25"), oneLegFilledAtMs: null, unhedgedDurationMs: null },
      [{ state: "PARTIAL_LEG", unhedgedStartedAtMs: null }],
      10_000,
    );
    expect(facts.hasUnhedgedFills).toBe(true);
    expect(facts.oneLegOpenMs).toBe(null);
    const v = evaluateInventoryRisk(healthyInventory(facts));
    expect(v.reasons.map((x) => x.code)).toContain("ONE_LEG_DURATION_EXCEEDED");
  });

  it("deriveCycleFacts: RECONCILED cycle with all legs closed is the ONLY risk-free shape", () => {
    const closed = deriveCycleFacts(
      { state: "RECONCILED", worstCaseLoss6: usdc("25"), oneLegFilledAtMs: 4_000, unhedgedDurationMs: 1_200 },
      [{ state: "HEDGED", unhedgedStartedAtMs: 5_000 }, { state: "SETTLED", unhedgedStartedAtMs: null }],
      10_000,
    );
    expect(closed).toEqual({
      cycleState: "RECONCILED", computedRiskFree: true, hasOpenLeg: false,
      hasUnhedgedFills: false, oneLegOpenMs: null, unhedgedExposure6: 0n,
    });
    // and that shape passes the risk-free gate even when labeled risk-free
    const v = evaluateInventoryRisk(healthyInventory({ ...closed, labeledRiskFree: true }));
    expect(v.reasons).toEqual([]);
  });

  it("derivePendingCtfValue6: PLANNED/SUBMITTED/UNKNOWN count fully, partials count the remainder, terminal states count 0", () => {
    expect(derivePendingCtfValue6([
      { state: "PLANNED", requestedAmount6: usdc("5"), confirmedAmount6: null },
      { state: "SUBMITTED", requestedAmount6: usdc("10"), confirmedAmount6: null },
      { state: "UNKNOWN", requestedAmount6: usdc("7"), confirmedAmount6: 1n }, // ambiguous -> full requested
      { state: "PARTIALLY_CONFIRMED", requestedAmount6: usdc("20"), confirmedAmount6: usdc("15") },
      { state: "CONFIRMED", requestedAmount6: usdc("100"), confirmedAmount6: usdc("100") },
      { state: "FAILED", requestedAmount6: usdc("100"), confirmedAmount6: null },
    ])).toBe(usdc("27")); // 5 + 10 + 7 + (20-15)
    expect(derivePendingCtfValue6([])).toBe(0n);
  });
});

describe("inventory hard rejects — each fires with a coded, human-readable reason", () => {
  const cases: Array<[string, Partial<InventoryRiskContext>, string]> = [
    ["live mode: paired/CTF flow is research-only by policy",
      { mode: "live" },
      "PAIRED_LIVE_NOT_ALLOWED"],
    ["labeled risk-free while a leg is open (even with zero fills: resting quotes are open)",
      { labeledRiskFree: true },
      "RISK_FREE_LABEL_WITH_OPEN_LEG"],
    ["COMPUTED risk-free while a leg is open (a correct isRiskFree can never do this — regression tripwire)",
      { computedRiskFree: true, hasUnhedgedFills: true, oneLegOpenMs: 100, cycleState: "ONE_LEG_FILLED" },
      "RISK_FREE_LABEL_WITH_OPEN_LEG"],
    ["one leg exposed beyond the duration budget",
      { hasUnhedgedFills: true, oneLegOpenMs: 2_500, cycleState: "ONE_LEG_FILLED" },
      "ONE_LEG_DURATION_EXCEEDED"],
    ["one leg exposed with UNKNOWN duration (unknown is treated as exceeded)",
      { hasUnhedgedFills: true, oneLegOpenMs: null, cycleState: "HEDGE_OR_CANCEL" },
      "ONE_LEG_DURATION_EXCEEDED"],
    ["unhedged exposure above the bankroll-fraction budget (1% of 1000 = 10)",
      { unhedgedExposure6: usdc("11") },
      "UNHEDGED_EXPOSURE_EXCEEDED"],
    ["EV positive only WITH unpaid rebates/rewards",
      { evExcludingUnpaidIncentivesPpm: 0n, evIncludingUnpaidIncentivesPpm: ppm("0.004") },
      "REWARD_REQUIRED_FOR_POSITIVE_EV"],
    ["EV claimed positive with incentives but never computed without them",
      { evExcludingUnpaidIncentivesPpm: null, evIncludingUnpaidIncentivesPpm: ppm("0.004") },
      "REWARD_REQUIRED_FOR_POSITIVE_EV"],
    ["pending CTF operation value above cap",
      { pendingCtfValue6: usdc("51") },
      "PENDING_CTF_VALUE_EXCEEDED"],
    ["attempts per intent exhausted (default allows exactly 1)",
      { attemptsForIntent: 1 },
      "INTENT_ATTEMPTS_EXHAUSTED"],
    ["cancel unconfirmed beyond the uncertainty budget",
      { cancelUncertaintyMs: 2_500 },
      "CANCEL_UNCERTAINTY_TIMEOUT"],
    ["per-outcome inventory cap (UP side)",
      { upInventory6: shares("201") },
      "OUTCOME_INVENTORY_EXCEEDED"],
    ["per-outcome inventory cap (DOWN side)",
      { downInventory6: shares("201") },
      "OUTCOME_INVENTORY_EXCEEDED"],
    ["daily operational/reconciliation loss stop (>= like the drawdown stops)",
      { dailyOperationalLoss6: usdc("20") },
      "OPERATIONAL_LOSS_STOP"],
    ["source-claim allocation above budget (5% of 1000 = 50)",
      { isSourceReproductionStrategy: true, sourceClaimAllocation6: usdc("51") },
      "SOURCE_CLAIM_ALLOCATION_EXCEEDED"],
  ];

  for (const [name, overrides, code] of cases) {
    it(`rejects: ${name}`, () => {
      const v = evaluateInventoryRisk(healthyInventory(overrides));
      expect(v.approved).toBe(false);
      expect(v.reasons.map((x) => x.code)).toContain(code);
      for (const reason of v.reasons) expect(reason.message.length).toBeGreaterThan(10);
    });
  }

  it("gross paired inventory cap fires independently of the per-outcome cap", () => {
    const v = evaluateInventoryRisk(healthyInventory({
      limits: { ...DEFAULT_INVENTORY_RISK_LIMITS, maxGrossPairedInventory6: shares("300") },
      upInventory6: shares("160"), downInventory6: shares("160"), // each ≤ 200, gross 320 > 300
    }));
    const codes = v.reasons.map((x) => x.code);
    expect(codes).toContain("GROSS_PAIRED_INVENTORY_EXCEEDED");
    expect(codes).not.toContain("OUTCOME_INVENTORY_EXCEEDED");
  });

  it("risk-free label with a CLOSED cycle is not rejected (RECONCILED earns the label)", () => {
    const v = evaluateInventoryRisk(healthyInventory({
      labeledRiskFree: true, computedRiskFree: true, hasOpenLeg: false, cycleState: "RECONCILED",
    }));
    expect(v.reasons.map((x) => x.code)).not.toContain("RISK_FREE_LABEL_WITH_OPEN_LEG");
  });

  it("EV negative both with and without incentives does not fire the reward gate (edge gates own that)", () => {
    const v = evaluateInventoryRisk(healthyInventory({
      evExcludingUnpaidIncentivesPpm: ppm("-0.01"), evIncludingUnpaidIncentivesPpm: ppm("-0.002"),
    }));
    expect(v.reasons.map((x) => x.code)).not.toContain("REWARD_REQUIRED_FOR_POSITIVE_EV");
  });

  it("a large source-claim allocation without a source-reproduction strategy does not fire", () => {
    const v = evaluateInventoryRisk(healthyInventory({
      isSourceReproductionStrategy: false, sourceClaimAllocation6: usdc("999"),
    }));
    expect(v.reasons.map((x) => x.code)).not.toContain("SOURCE_CLAIM_ALLOCATION_EXCEEDED");
  });

  it("zero bankroll means zero unhedged budget: any exposure rejects", () => {
    const v = evaluateInventoryRisk(healthyInventory({ bankroll6: 0n, unhedgedExposure6: 1n }));
    expect(v.reasons.map((x) => x.code)).toContain("UNHEDGED_EXPOSURE_EXCEEDED");
  });

  it("shadow mode passes the live-policy gate (research modes are the point)", () => {
    const v = evaluateInventoryRisk(healthyInventory({ mode: "shadow" }));
    expect(v.reasons).toEqual([]);
  });

  it("returns ALL failing reasons, not just the first, and every code is in the hard-reject set", () => {
    const v = evaluateInventoryRisk(healthyInventory({
      mode: "live",
      labeledRiskFree: true, computedRiskFree: true,
      hasOpenLeg: true, hasUnhedgedFills: true, oneLegOpenMs: null,
      cycleState: "HALTED",
      unhedgedExposure6: usdc("999"),
      evExcludingUnpaidIncentivesPpm: 0n, evIncludingUnpaidIncentivesPpm: ppm("0.01"),
      pendingCtfValue6: usdc("51"),
      attemptsForIntent: 5,
      cancelUncertaintyMs: 9_999,
      upInventory6: shares("500"), downInventory6: shares("10"),
      dailyOperationalLoss6: usdc("20"),
      isSourceReproductionStrategy: true, sourceClaimAllocation6: usdc("100"),
    }));
    const codes = new Set(v.reasons.map((x) => x.code));
    expect(codes).toEqual(INVENTORY_HARD_REJECT_CODES);
    expect(v.approved).toBe(false);
  });
});

describe("integration with evaluateOrderRisk", () => {
  it("absent inventory context leaves the Phase-1 verdict identical", () => {
    const withUndefined = evaluateOrderRisk(healthyCtx());
    const withNull = evaluateOrderRisk(healthyCtx({ inventory: null }));
    expect(withUndefined.approved).toBe(true);
    expect(withNull).toEqual(withUndefined);
  });

  it("healthy directional gates + broken inventory -> rejected with the inventory code", () => {
    const v = evaluateOrderRisk(healthyCtx({
      inventory: healthyInventory({ hasUnhedgedFills: true, oneLegOpenMs: 5_000, cycleState: "ONE_LEG_FILLED" }),
    }));
    expect(v.approved).toBe(false);
    expect(v.reasons.map((x) => x.code)).toContain("ONE_LEG_DURATION_EXCEEDED");
  });

  it("healthy directional gates + healthy inventory -> approved", () => {
    const v = evaluateOrderRisk(healthyCtx({ inventory: healthyInventory() }));
    expect(v.reasons).toEqual([]);
    expect(v.approved).toBe(true);
  });
});

describe("ABSOLUTE_MAX_RISK_FRACTION discipline", () => {
  it("property: inventory context can only ADD rejections — sizing is byte-identical and never exceeds the absolute cap", () => {
    fc.assert(
      fc.property(
        fc.bigInt(1_000_000n, 100_000_000_000n),   // bankroll 1..100k USDC
        fc.bigInt(0n, 1_000_000n),                 // requested stake fraction
        fc.bigInt(0n, 2_000_000_000_000n),         // unhedged exposure
        fc.bigInt(0n, 1_000_000_000_000n),         // up inventory
        fc.bigInt(0n, 1_000_000_000_000n),         // down inventory
        fc.bigInt(0n, 1_000_000_000_000n),         // pending CTF value
        fc.integer({ min: 0, max: 10 }),           // attempts already made
        fc.option(fc.integer({ min: 0, max: 60_000 }), { nil: null }), // one-leg ms
        fc.boolean(), fc.boolean(),                // labeled / computed risk-free
        fc.boolean(), fc.boolean(),                // open leg / unhedged fills
        (bank, req, unhedged, up, down, ctf, attempts, legMs, labeled, computed, openLeg, unhedgedFills) => {
          const base = healthyCtx({
            bankroll: { ...healthyCtx().bankroll, bankroll: bank, sessionPeak: bank, dailyPeak: bank },
            requestedStakeFractionPpm: req,
          });
          const inv = healthyInventory({
            bankroll6: bank, unhedgedExposure6: unhedged,
            upInventory6: up, downInventory6: down, pendingCtfValue6: ctf,
            attemptsForIntent: attempts, oneLegOpenMs: legMs,
            labeledRiskFree: labeled, computedRiskFree: computed,
            hasOpenLeg: openLeg, hasUnhedgedFills: unhedgedFills,
          });
          const without = evaluateOrderRisk(base);
          const withInv = evaluateOrderRisk({ ...base, inventory: inv });

          // 1. No new authorization path: sizing is exactly what Phase 1 computes.
          const sizingIdentical =
            withInv.sizing!.stake6 === without.sizing!.stake6 &&
            withInv.sizing!.fractionPpm === without.sizing!.fractionPpm;
          // 2. Nothing exceeds the absolute cap.
          const underAbsoluteCap = withInv.sizing!.fractionPpm <= ABSOLUTE_MAX_RISK_PPM;
          // 3. Inventory can only add reasons: Phase-1 reasons are a subset.
          // (STAKE_BELOW_MINIMUM / NO_EXECUTABLE_SIZE are excluded: by Phase-1
          // design they only fire on otherwise-clean verdicts.)
          const conditionalCodes = new Set(["STAKE_BELOW_MINIMUM", "NO_EXECUTABLE_SIZE"]);
          const withCodes = new Set(withInv.reasons.map((x) => x.code));
          const subset = without.reasons.every((x) => conditionalCodes.has(x.code) || withCodes.has(x.code));
          // 4. Therefore approval can only be revoked, never granted, by inventory.
          const noNewApproval = !withInv.approved || without.approved;

          return sizingIdentical && underAbsoluteCap && subset && noNewApproval;
        },
      ),
    );
  });
});

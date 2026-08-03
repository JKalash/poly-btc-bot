import { describe, expect, it } from "vitest";
import { ppm, prob, usdc } from "@b5p/domain";
import {
  RISK_PROFILES, evaluateOrderRisk, governanceForMode,
  type GovernanceModelFlags, type RiskContext,
} from "../src/index";

/** Same healthy baseline as risk.test.ts — each test perturbs one thing. */
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
    modelApprovedForMode: true, strategyValidatedForMode: true,
    coolingOffUntilMs: null, nowMs: 1_000_000,
    idempotencyKeyIsDuplicate: false,
    requestedStakeFractionPpm: null, minOrderStake6: usdc("1"),
    ...overrides,
  };
}

/** Approval flags of every UNCALIBRATED model (composite, heuristic, baseline). */
const UNCALIBRATED: GovernanceModelFlags = { approvedForPaper: true, approvedForLive: false };
/** Flags of a calibrated model whose promotion PASSED (artifact + positive lower-CI net EV). */
const PROMOTED: GovernanceModelFlags = { approvedForPaper: true, approvedForLive: true };

const LIVE_PROMOTION = { approved: true, active: true, mode: "live" };

describe("governanceForMode", () => {
  it("paper/shadow: paper approval suffices, validation is not demanded of the mode that produces it", () => {
    expect(governanceForMode("paper", false, UNCALIBRATED, null))
      .toEqual({ modelApprovedForMode: true, strategyValidatedForMode: true });
    expect(governanceForMode("shadow", false, UNCALIBRATED, null))
      .toEqual({ modelApprovedForMode: true, strategyValidatedForMode: true });
  });

  it("live without evidence: BOTH governance gates fail", () => {
    expect(governanceForMode("live", false, UNCALIBRATED, null))
      .toEqual({ modelApprovedForMode: false, strategyValidatedForMode: false });
  });

  it("live with a calibrated model but no promotion decision: strategy stays unvalidated", () => {
    expect(governanceForMode("live", false, PROMOTED, null))
      .toEqual({ modelApprovedForMode: true, strategyValidatedForMode: false });
  });

  it("live with failing/inactive/paper-mode decisions: unvalidated", () => {
    expect(governanceForMode("live", false, PROMOTED, { approved: false, active: true, mode: "live" }).strategyValidatedForMode).toBe(false);
    expect(governanceForMode("live", false, PROMOTED, { approved: true, active: false, mode: "live" }).strategyValidatedForMode).toBe(false);
    expect(governanceForMode("live", false, PROMOTED, { approved: true, active: true, mode: "paper" }).strategyValidatedForMode).toBe(false);
  });

  it("live with full evidence: both gates pass without any override", () => {
    expect(governanceForMode("live", false, PROMOTED, LIVE_PROMOTION))
      .toEqual({ modelApprovedForMode: true, strategyValidatedForMode: true });
  });
});

describe("ANTI-PATTERN: an uncalibrated composite score can never reach Kelly sizing", () => {
  it("live + composite model + healthy everything else -> rejected with BOTH governance codes; Kelly is never authorized", () => {
    const gov = governanceForMode("live", false, UNCALIBRATED, null);
    const v = evaluateOrderRisk(healthyCtx({ mode: "live", ...gov }));
    expect(v.approved).toBe(false);
    const codes = v.reasons.map((x) => x.code);
    expect(codes).toContain("MODEL_NOT_APPROVED");
    expect(codes).toContain("STRATEGY_UNVALIDATED");
  });

  it("a maximally confident score changes nothing: governance looks at evidence flags, not scores", () => {
    // there is no score input at all — by construction a composite score cannot
    // influence governance; only artifact-backed approval flags can
    const gov = governanceForMode("live", false, UNCALIBRATED, null);
    expect(gov.modelApprovedForMode).toBe(false);
  });
});

describe("live-arm override bypasses EXACTLY the two governance gates", () => {
  it("override clears MODEL_NOT_APPROVED and STRATEGY_UNVALIDATED — and nothing else", () => {
    // break several unrelated gates AND governance
    const broken: Partial<RiskContext> = {
      mode: "live",
      chainlinkAgeMs: 9999,               // CHAINLINK_STALE
      conservativeProbability: prob("0.55"), // INSUFFICIENT_EDGE at price 0.55
      spread: prob("0.05"),               // SPREAD_TOO_WIDE
    };
    const unarmed = evaluateOrderRisk(healthyCtx({ ...broken, ...governanceForMode("live", false, UNCALIBRATED, null) }));
    const armed = evaluateOrderRisk(healthyCtx({ ...broken, ...governanceForMode("live", true, UNCALIBRATED, null) }));

    const unarmedCodes = new Set(unarmed.reasons.map((x) => x.code));
    const armedCodes = new Set(armed.reasons.map((x) => x.code));

    // the ONLY difference arming makes is the two governance codes
    const removed = [...unarmedCodes].filter((c) => !armedCodes.has(c)).sort();
    expect(removed).toEqual(["MODEL_NOT_APPROVED", "STRATEGY_UNVALIDATED"]);
    const added = [...armedCodes].filter((c) => !unarmedCodes.has(c));
    expect(added).toEqual([]);

    // every economic/safety gate still fires while armed
    expect(armed.approved).toBe(false);
    expect(armedCodes.has("CHAINLINK_STALE")).toBe(true);
    expect(armedCodes.has("INSUFFICIENT_EDGE")).toBe(true);
    expect(armedCodes.has("SPREAD_TOO_WIDE")).toBe(true);
  });

  it("armed + healthy economics -> approved, but only because economics pass", () => {
    const gov = governanceForMode("live", true, UNCALIBRATED, null);
    const v = evaluateOrderRisk(healthyCtx({ mode: "live", ...gov }));
    expect(v.reasons).toEqual([]);
    expect(v.approved).toBe(true);
  });
});

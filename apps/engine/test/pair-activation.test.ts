import { describe, expect, it, vi } from "vitest";
import type { ImmutableBookView } from "@b5p/strategy";
import type {
  PairMarketContext,
  PairPolicySnapshot,
  PairPortfolioSnapshot,
  PairTokenTerms,
  PairTokenTermsProvider,
} from "@b5p/pair-execution";
import {
  requotePairActivation,
  type PairActivationBookSelection,
  type RequotePairActivationInput,
} from "../src/pair-activation";

const DISPATCH_MS = 10_000;

function terms(outcome: "UP" | "DOWN", suffix = "1", feeRate = 0n): PairTokenTerms {
  const tokenId = outcome === "UP" ? "up" : "down";
  return Object.freeze({
    outcome,
    tokenId,
    constraints: Object.freeze({
      snapshotId: `${tokenId}-constraint-${suffix}`,
      tokenId,
      tickSize6: 10_000n,
      minimumOrderShares6: 1_000_000n,
      effectiveAtMs: 1,
      fetchedAtMs: 2,
      source: "test",
      canonicalHash: `${tokenId}-constraint-hash-${suffix}`,
    }),
    fee: Object.freeze({
      snapshotId: `${tokenId}-fee-${suffix}`,
      tokenId,
      tokenFeeRatePpm: feeRate,
      convention: "USDC",
      conventionResolverVersion: "test-v1",
      effectiveAtMs: 1,
      fetchedAtMs: 2,
      source: "test",
      canonicalHash: `${tokenId}-fee-hash-${suffix}`,
    }),
  });
}

const SIGNAL_UP = terms("UP");
const SIGNAL_DOWN = terms("DOWN");

const POLICY: PairPolicySnapshot = Object.freeze({
  strategyVersion: "complete_set_pair_v0_RESEARCH_ONLY",
  route: "DIRECT_BUY_BOTH",
  observerEnabled: true,
  paperSchedulingEnabled: true,
  liveExecutionAvailable: false,
  dispatchModel: "PARALLEL",
  activationLatencyMs: 350,
  interLegDelayMs: 0,
  activationQuoteTtlMs: 1_000,
  settlementPolicy: "HOLD_TO_RESOLUTION",
  modeledSettlementDelayMs: 0,
  modeledSettlementCost6: 0n,
  settlementCashReserve6: 0n,
  recoveryPolicy: "NO_AUTO_RECOVERY",
  maximumRecoveryAttempts: 0,
  recoveryDeadlineMs: 0,
  recoveryReserve6: 0n,
  maximumBookAgeMs: 2_000,
  maximumSourceSkewMs: 100,
  maximumReceiveSkewMs: 100,
  maximumFutureTimestampMs: 25,
  maximumFeeSnapshotAgeMs: 10_000,
  maximumConstraintSnapshotAgeMs: 10_000,
  minimumNetPnl6: 1n,
  minimumNetReturnPpm: 1n,
  operationalRiskHaircut6: 0n,
  maximumCashFractionPpm: 100_000n,
  maximumResidualLossFractionPpm: 100_000n,
  maximumAggregateReservedFractionPpm: 200_000n,
  maximumAggregateResidualLossFractionPpm: 200_000n,
  maximumPairDailyLossFractionPpm: 100_000n,
  maximumPairSessionDrawdownFractionPpm: 100_000n,
  maximumActivePairGroups: 1,
  pairShareLot6: 1_000_000n,
  maximumPairShares6: 20_000_000n,
  requireOneTickStressPositive: true,
  requireTwoTickStressPositive: true,
  depthStressFractionsPpm: [750_000n, 500_000n, 250_000n] as const,
  entryCutoffSeconds: 30,
  episodeCooloffMs: 1_000,
  negativeControlSamplePpm: 0n,
  unknownResultTimeoutMs: 1_000,
  hardRiskConstant: { name: "ABSOLUTE_MAX_RISK_FRACTION" as const, valuePpm: 100_000n, sourceVersion: "test" },
  configVersion: 7,
  policyHash: "policy-7",
});

const PORTFOLIO: PairPortfolioSnapshot = Object.freeze({
  snapshotId: "portfolio-1",
  referenceBankroll6: 1_000_000_000n,
  pairAccountCashBalance6: 1_000_000_000n,
  pairCashReserved6: 0n,
  pairPendingSettlementReserved6: 0n,
  pairCashAvailable6: 1_000_000_000n,
  directionalFreeCash6: 1_000_000_000n,
  sharedCapAvailable6: 1_000_000_000n,
  globalAppMode: "paper",
  directionalLiveArmed: false,
  activePairGroupCount: 0,
  aggregatePairWorstCaseLoss6: 0n,
  pairDailyRealizedPnl6: 0n,
  pairSessionPeakCash6: 1_000_000_000n,
  activeDirectionalMarketIds: [],
  openDirectionalMarketIds: [],
  activePairMarketIds: [],
  reconciledAtMs: DISPATCH_MS,
  healthy: true,
  hash: "portfolio-hash-1",
});

function market(): PairMarketContext {
  return Object.freeze({
    marketId: "market-1",
    conditionId: "condition-1",
    slug: "btc-5m",
    up: SIGNAL_UP,
    down: SIGNAL_DOWN,
    startsAtMs: 0,
    endsAtMs: 100_000,
    acceptingOrders: true,
    negRisk: false,
    marketStructure: "BINARY_EXHAUSTIVE_MUTUALLY_EXCLUSIVE",
    invalidOrVoidPolicyVerified: true,
    rulesVerified: true,
    rulesHash: "rules-1",
    resolutionSource: "CHAINLINK",
    secondsRemaining: 90,
    configVersion: 7,
  });
}

function view(tokenId: "up" | "down", price = 450_000n, receivedTsMs = DISPATCH_MS - 10): ImmutableBookView {
  return Object.freeze({
    tokenId,
    marketId: "market-1",
    bookVersion: 12n,
    connectionEpoch: "epoch-1",
    bids: Object.freeze([Object.freeze({ price: price - 10_000n, size: 10_000_000n })]),
    asks: Object.freeze([Object.freeze({ price, size: 10_000_000n })]),
    sourceTsMs: receivedTsMs - 1,
    receivedTsMs,
    exchangeHash: null,
    sourceEventId: `${tokenId}-event-12`,
    integrity: "VERIFIED_SNAPSHOT",
  });
}

function provider(up = SIGNAL_UP, down = SIGNAL_DOWN): PairTokenTermsProvider {
  return { currentTerms: vi.fn(async () => ({ kind: "READY" as const, up, down })) };
}

function selection(up = view("up"), down = view("down"), sequence = 40n): PairActivationBookSelection {
  return Object.freeze({ completedReceiveSequence: sequence, up, down });
}

function input(overrides: Partial<RequotePairActivationInput> = {}): RequotePairActivationInput {
  return {
    groupId: "group-1",
    scheduledDueMs: DISPATCH_MS - 5,
    actualDispatchMs: DISPATCH_MS,
    activationCaptureSequence: 22n,
    cutoff: { receiveSequence: 40n, dataCutoffEventId: "event-40", dataCutoffEnvelopeId: "envelope-40" },
    market: market(),
    signalAuthority: {
      signalCaptureId: "pcap_signal",
      signalCaptureHash: "signal-capture-hash",
      signalQuoteHash: "signal-quote-hash",
      approvedGrossShares6: 5_000_000n,
      policyHash: POLICY.policyHash,
      rulesHash: "rules-1",
      permitExpiresAtMs: DISPATCH_MS + 1,
    },
    decisionRepresentation: { kind: "REVALIDATE_SIGNAL" },
    policy: POLICY,
    portfolioForRisk: PORTFOLIO,
    engineHalted: false,
    activationPermitId: "activation-permit-1",
    bookSource: { latestCompleteAtOrBefore: vi.fn(async () => selection()) },
    termsProvider: provider(),
    ...overrides,
  };
}

describe("pair activation requote", () => {
  it("passes the exact causal cutoff to the as-of source and never accepts forward evidence", async () => {
    const source = {
      latestCompleteAtOrBefore: vi.fn(async () => selection(view("up"), view("down"), 41n)),
    };
    const termSource = provider();
    const result = await requotePairActivation(input({ bookSource: source, termsProvider: termSource }));

    expect(source.latestCompleteAtOrBefore).toHaveBeenCalledWith({
      marketId: "market-1", upTokenId: "up", downTokenId: "down",
      dispatchedAtMs: DISPATCH_MS, cutoffReceiveSequence: 40n,
    });
    expect(result.kind).toBe("REJECTED");
    expect(result.data.gateResult.reasons.map((reason) => reason.code)).toEqual(["ACTIVATION_CAUSALITY_VIOLATION"]);
    expect(termSource.currentTerms).not.toHaveBeenCalled();
  });

  it("creates a new immutable activation capture even when both book versions are unchanged", async () => {
    const result = await requotePairActivation(input());

    expect(result.kind).toBe("APPROVED");
    expect(result.data.activationCapture?.up.bookVersion).toBe(12n);
    expect(result.data.activationCapture?.down.bookVersion).toBe(12n);
    expect(result.data.activationCapture?.captureId).not.toBe("pcap_signal");
    expect(result.data.activationCapture?.capturedAtMs).toBe(DISPATCH_MS);
    expect(Object.isFrozen(result.data)).toBe(true);
    expect(Object.isFrozen(result.data.activationCapture)).toBe(true);
  });

  it("rejects changed fee/constraint identities explicitly when only revalidating the signal", async () => {
    const changedUp = Object.freeze({
      ...SIGNAL_UP,
      fee: Object.freeze({ ...SIGNAL_UP.fee, snapshotId: "up-fee-2", canonicalHash: "up-fee-hash-2", tokenFeeRatePpm: 100n }),
    });
    const changedDown = Object.freeze({
      ...SIGNAL_DOWN,
      constraints: Object.freeze({ ...SIGNAL_DOWN.constraints, snapshotId: "down-constraint-2", canonicalHash: "down-constraint-hash-2" }),
    });
    const result = await requotePairActivation(input({ termsProvider: provider(changedUp, changedDown) }));

    expect(result.kind).toBe("REJECTED");
    expect(result.data.gateResult.reasons.map((reason) => reason.code)).toEqual([
      "ACTIVATION_FEE_CHANGED", "ACTIVATION_CONSTRAINT_CHANGED",
    ]);
    expect(result.data.termChanges).toHaveLength(2);
    expect(result.data.quote).toBeNull();
  });

  it("allows changed terms only when the payload represents a wholly new activation decision", async () => {
    const changedUp = Object.freeze({
      ...SIGNAL_UP,
      fee: Object.freeze({ ...SIGNAL_UP.fee, snapshotId: "up-fee-2", canonicalHash: "up-fee-hash-2", tokenFeeRatePpm: 100n }),
    });
    const result = await requotePairActivation(input({
      termsProvider: provider(changedUp, SIGNAL_DOWN),
      decisionRepresentation: { kind: "NEW_ACTIVATION_DECISION", decisionId: "decision-activation-2" },
    }));

    expect(result.kind).toBe("APPROVED");
    expect(result.data.termChanges.map((change) => change.kind)).toEqual(["FEE"]);
    expect(result.data.currentTerms?.up.fee.snapshotId).toBe("up-fee-2");
  });

  it("never increases quantity above the signal-approved maximum", async () => {
    const result = await requotePairActivation(input({
      signalAuthority: { ...input().signalAuthority, approvedGrossShares6: 5_000_000n },
    }));

    expect(result.kind).toBe("APPROVED");
    expect(result.data.selectedGrossShares6).toBe(5_000_000n);
    expect(result.data.quote?.pairGrossShares6).toBeLessThanOrEqual(5_000_000n);
  });

  it("reruns exact risk gates and keeps the rejected activation quote as persistence evidence", async () => {
    const starved = Object.freeze({ ...PORTFOLIO, pairCashAvailable6: 1n, sharedCapAvailable6: 1n, hash: "starved" });
    const result = await requotePairActivation(input({ portfolioForRisk: starved }));

    expect(result.kind).toBe("REJECTED");
    expect(result.data.gateResult.reasons.map((reason) => reason.code)).toContain("ACTIVATION_RISK_REJECTED");
    expect(result.data.gateResult.reasons.map((reason) => reason.code)).toContain("AVAILABLE_CASH_INSUFFICIENT");
    expect(result.data.quote).not.toBeNull();
    expect(result.data.quote?.oneTickWorse.kind).toBe("EXECUTABLE");
    expect(result.data.quote?.twoTicksWorse.kind).toBe("EXECUTABLE");
    expect(result.data.quote?.depthStress).toHaveLength(3);
    expect(result.data.riskDecision.kind).toBe("REJECTED");
    expect("effects" in result.data).toBe(false);
  });

  it("fails closed without asking terms when there is no complete as-of book", async () => {
    const termSource = provider();
    const result = await requotePairActivation(input({
      bookSource: { latestCompleteAtOrBefore: vi.fn(async () => null) },
      termsProvider: termSource,
    }));

    expect(result.kind).toBe("REJECTED");
    expect(result.data.gateResult.reasons.map((reason) => reason.code)).toEqual(["ACTIVATION_DATA_UNAVAILABLE"]);
    expect(termSource.currentTerms).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  canonicalObjectHash,
  pairCaptureHash,
  pairCaptureId,
  type ImmutablePairBookLeg,
  type PairBookCapture,
  type PairRecoveryPolicy,
} from "@b5p/pair-execution";
import { canonicalBookHash } from "@b5p/strategy";
import {
  PairRecoveryCoordinatorError,
  classifyRecoveryEvidence,
  commitPairRecovery,
  planPairRecovery,
  recoveryEvidenceFacts,
  type PairRecoveryPlan,
  type PairRecoveryPlanInput,
} from "../src/pair-recovery-coordinator";
import { decodePaperPairOutboxRequest } from "../src/pair-outbox-dispatcher";
import {
  InMemoryPaperPairOperationStore,
  PaperPairVenue,
  type PaperPairEffectEvidence,
} from "../src/paper-pair-venue";

const now = 1_800_000_000_000;

function capture(upBidShares6 = 1_000_000n): PairBookCapture {
  const up: ImmutablePairBookLeg = Object.freeze({
    outcome: "UP", tokenId: "up", bookVersion: 21n, connectionEpoch: "recovery-epoch", sourceTsMs: now,
    receivedTsMs: now, exchangeHash: null, sourceEventId: "up-recovery", integrity: "VERIFIED_SNAPSHOT",
    bids: Object.freeze([{ price6: 550_000n, shares6: upBidShares6 }]),
    asks: Object.freeze([{ price6: 560_000n, shares6: 1_000_000n }]),
  });
  const down: ImmutablePairBookLeg = Object.freeze({
    outcome: "DOWN", tokenId: "down", bookVersion: 22n, connectionEpoch: "recovery-epoch", sourceTsMs: now,
    receivedTsMs: now, exchangeHash: null, sourceEventId: "down-recovery", integrity: "VERIFIED_SNAPSHOT",
    bids: Object.freeze([{ price6: 380_000n, shares6: 1_000_000n }]),
    asks: Object.freeze([{ price6: 390_000n, shares6: 1_000_000n }]),
  });
  const contentHash = (leg: ImmutablePairBookLeg) => canonicalBookHash({
    tokenId: leg.tokenId, marketId: "market", bookVersion: leg.bookVersion, connectionEpoch: leg.connectionEpoch,
    sourceTsMs: leg.sourceTsMs, receivedTsMs: leg.receivedTsMs, exchangeHash: leg.exchangeHash,
    sourceEventId: leg.sourceEventId, integrity: leg.integrity,
    bids: leg.bids.map((x) => ({ price: x.price6, size: x.shares6 })),
    asks: leg.asks.map((x) => ({ price: x.price6, size: x.shares6 })),
  });
  const captureHash = pairCaptureHash({
    marketId: "market", conditionId: "condition", capturedAtMs: now, captureSequence: 9n,
    up: { ...up, contentHash: contentHash(up) }, down: { ...down, contentHash: contentHash(down) },
    sourceSkewMs: 0, receiveSkewMs: 0,
  });
  return Object.freeze({
    captureId: pairCaptureId({ captureHash }), marketId: "market", conditionId: "condition", capturedAtMs: now,
    captureSequence: 9n, up, down, sourceSkewMs: 0, receiveSkewMs: 0, captureHash,
  });
}

const terms = Object.freeze({
  minimumOrderShares6: 1_000_000n,
  shareLot6: 1_000_000n,
  fee: Object.freeze({ ratePpm: 0n, collection: "usdc" as const }),
});

function input(policy: PairRecoveryPolicy = "NO_AUTO_RECOVERY", overrides: Partial<PairRecoveryPlanInput> = {}): PairRecoveryPlanInput {
  return {
    groupId: "group",
    actionSequence: 2,
    recoveryDecisionId: "recovery-decision",
    recoveryRiskDecisionId: "recovery-risk",
    capture: capture(),
    residualEnteredAtMs: now - 10,
    nowMs: now,
    deadlineMs: now + 1_000,
    policy,
    recoveryAttempts: 0,
    maximumRecoveryAttempts: policy === "NO_AUTO_RECOVERY" ? 0 : 1,
    initialOutcomeUnknown: false,
    halted: false,
    booksEligible: true,
    residualOutcome: "UP",
    residualShares6: 1_000_000n,
    residualCostBasis6: 600_000n,
    upHeldShares6: 1_000_000n,
    downHeldShares6: 0n,
    currentWorstCaseLoss6: 600_000n,
    remainingCash6: 1_000_000n,
    recoveryReserve6: 1_000_000n,
    maximumLockedLoss6: 600_000n,
    upTerms: terms,
    downTerms: terms,
    ...overrides,
  };
}

function outboxRow(plan: PairRecoveryPlan) {
  const effect = plan.effects[0]!;
  return {
    ...effect,
    groupId: plan.groupId,
    state: "PENDING",
    claimToken: null,
    claimedAtMs: null,
    claimExpiresAtMs: null,
    attemptCount: 0,
    resultEvidenceId: null,
    lastErrorCode: null,
    updatedAtMs: now,
  };
}

function alternateEvidence(plan: PairRecoveryPlan, kind: "NO_FILL" | "REJECTED" | "UNKNOWN"): PaperPairEffectEvidence {
  const effect = plan.effects[0]!;
  const result = kind === "NO_FILL"
    ? { kind, code: "NO_FILL_LIMIT" as const }
    : kind === "REJECTED"
      ? { kind, code: "REJECTED_SCRIPTED" as const, detail: "fixture" }
      : { kind, reason: "UNKNOWN_SIMULATED_TIMEOUT" as const };
  return Object.freeze({
    evidenceId: `evidence-${kind}`,
    effectId: effect.id,
    clientOperationId: effect.clientOperationId,
    idempotencyKey: effect.idempotencyKey,
    requestHash: effect.requestHash,
    captureId: plan.captureId,
    operationKind: plan.request!.operationKind,
    state: kind === "UNKNOWN" ? "OUTCOME_UNKNOWN" : kind === "REJECTED" ? "TERMINAL_REJECTED" : "NO_FILL",
    result,
    resultHash: canonicalObjectHash(result),
    computedAtMs: now + 1,
  });
}

describe("recovery coordinator planning", () => {
  it("always captures all alternatives and the default policy commits zero effects", async () => {
    const commitRecoveryPlan = vi.fn(async (plan: PairRecoveryPlan) => {
      expect(plan.alternatives.map((alternative) => alternative.kind)).toEqual([
        "COMPLETE_MISSING_LEG", "LIQUIDATE_FILLED_LEG", "HOLD_TO_RESOLUTION",
      ]);
      expect(plan.effects).toEqual([]);
      return { kind: "COMMITTED" as const };
    });
    const result = await commitPairRecovery(input(), { commitRecoveryPlan });
    expect(commitRecoveryPlan).toHaveBeenCalledTimes(1);
    expect(result.plan.selection).toMatchObject({ kind: "SKIP", reason: "NO_AUTO_RECOVERY" });
    expect(result.plan.facts.map((entry) => entry.type)).toEqual([
      "PAIR_RECOVERY_ALTERNATIVES_CAPTURED", "PAIR_RECOVERY_SKIPPED",
    ]);
    expect(result.committedEffects).toEqual([]);
  });

  it("plans at most one deterministic future-capture complement BUY FOK within all gates", () => {
    const first = planPairRecovery(input("PAPER_COMPLETE_MISSING_LEG"));
    const replayed = planPairRecovery(input("PAPER_COMPLETE_MISSING_LEG"));
    expect(replayed).toEqual(first);
    expect(first.effects).toHaveLength(1);
    expect(first.effects[0]).toMatchObject({ effectOrdinal: 0, actionSequence: 2 });
    expect(first.request).toMatchObject({
      operationKind: "RECOVERY_BUY_FOK",
      leg: { outcome: "DOWN", side: "BUY", timeInForce: "FOK", grossShares6: 1_000_000n, maximumCashDebit6: 390_000n },
    });
    expect(decodePaperPairOutboxRequest(outboxRow(first))).toEqual(first.request);
    expect(first.captureId).not.toBe("old-residual-capture");

    for (const blocked of [
      input("PAPER_COMPLETE_MISSING_LEG", { halted: true }),
      input("PAPER_COMPLETE_MISSING_LEG", { initialOutcomeUnknown: true }),
      input("PAPER_COMPLETE_MISSING_LEG", { recoveryAttempts: 1 }),
      input("PAPER_COMPLETE_MISSING_LEG", { nowMs: now + 1_001 }),
      input("PAPER_COMPLETE_MISSING_LEG", { residualEnteredAtMs: now }),
    ]) {
      expect(planPairRecovery(blocked).effects).toEqual([]);
    }
  });

  it("plans liquidation only as SELL FAK with exact proven inventory", () => {
    const full = planPairRecovery(input("PAPER_LIQUIDATE_FILLED_LEG"));
    expect(full.effects).toHaveLength(1);
    expect(full.request).toMatchObject({
      operationKind: "RECOVERY_SELL_FAK",
      leg: { outcome: "UP", side: "SELL", timeInForce: "FAK", grossShares6: 1_000_000n, availableShares6: 1_000_000n },
    });
    const partial = planPairRecovery(input("PAPER_LIQUIDATE_FILLED_LEG", { capture: capture(400_000n) }));
    expect(partial.selection).toMatchObject({ kind: "ACT", alternative: { kind: "LIQUIDATE_FILLED_LEG", actionQuantity6: 400_000n } });
    expect(partial.request?.leg.grossShares6).toBe(1_000_000n);
    expect(partial.effects).toHaveLength(1);
  });
});

describe("recovery evidence classification", () => {
  it("classifies successful complement as paired and UNKNOWN/no-fill without changing exposure", async () => {
    const plan = planPairRecovery(input("PAPER_COMPLETE_MISSING_LEG"));
    const venue = new PaperPairVenue(new InMemoryPaperPairOperationStore(), { now: () => now + 1 });
    const filled = await venue.executeIdempotently(plan.request!);
    expect(classifyRecoveryEvidence(plan, filled)).toEqual({
      kind: "PAIRED", upHeldShares6: 1_000_000n, downHeldShares6: 1_000_000n, cashDebit6: 390_000n,
    });
    expect(classifyRecoveryEvidence(plan, alternateEvidence(plan, "UNKNOWN"))).toEqual({
      kind: "RECOVERY_OUTCOME_UNKNOWN", upHeldShares6: 1_000_000n, downHeldShares6: 0n,
    });
    expect(classifyRecoveryEvidence(plan, alternateEvidence(plan, "NO_FILL"))).toEqual({
      kind: "HOLD_REMAINDER", upHeldShares6: 1_000_000n, downHeldShares6: 0n,
      cashDebit6: 0n, cashCredit6: 0n, remainingResidualShares6: 1_000_000n,
    });
    const facts = recoveryEvidenceFacts({ plan, evidence: alternateEvidence(plan, "UNKNOWN"), occurredAtMs: now + 2 });
    expect(facts).toHaveLength(1);
    expect(facts[0]?.type).toBe("PAIR_RECOVERY_OUTCOME_UNKNOWN");
    expect(recoveryEvidenceFacts({ plan, evidence: alternateEvidence(plan, "UNKNOWN"), occurredAtMs: now + 2 })).toEqual(facts);
  });

  it("keeps a partial liquidation remainder explicit and classifies a full liquidation flat", async () => {
    const partialPlan = planPairRecovery(input("PAPER_LIQUIDATE_FILLED_LEG", { capture: capture(400_000n) }));
    const partialVenue = new PaperPairVenue(new InMemoryPaperPairOperationStore(), { now: () => now + 1 });
    const partial = await partialVenue.executeIdempotently(partialPlan.request!);
    expect(partial.result.kind).toBe("PARTIAL_CANCELED");
    expect(classifyRecoveryEvidence(partialPlan, partial)).toEqual({
      kind: "HOLD_REMAINDER", upHeldShares6: 600_000n, downHeldShares6: 0n,
      cashDebit6: 0n, cashCredit6: 220_000n, remainingResidualShares6: 600_000n,
    });
    expect(recoveryEvidenceFacts({ plan: partialPlan, evidence: partial, occurredAtMs: now + 2 })[0]).toMatchObject({
      type: "PAIR_RECOVERY_RESULT_RECORDED",
      payload: { upHeldShares6: 600_000n, downHeldShares6: 0n, cashCredit6: 220_000n, currentWorstCaseLoss6: 360_000n },
    });

    const fullPlan = planPairRecovery(input("PAPER_LIQUIDATE_FILLED_LEG"));
    const full = await new PaperPairVenue(new InMemoryPaperPairOperationStore(), { now: () => now + 1 }).executeIdempotently(fullPlan.request!);
    expect(classifyRecoveryEvidence(fullPlan, full)).toEqual({
      kind: "FLAT", upHeldShares6: 0n, downHeldShares6: 0n, cashCredit6: 550_000n,
    });
  });

  it("rejects duplicate commit hashes that do not match the deterministic recovery plan", async () => {
    await expect(commitPairRecovery(input(), {
      commitRecoveryPlan: async () => ({ kind: "DUPLICATE", planHash: "different" }),
    })).rejects.toBeInstanceOf(PairRecoveryCoordinatorError);
  });
});

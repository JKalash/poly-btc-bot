import { describe, expect, it, vi } from "vitest";
import {
  canonicalObjectHash,
  pairCaptureHash,
  pairCaptureId,
  pairLegId,
  type ImmutablePairBookLeg,
  type PairBookCapture,
  type PairGroupId,
} from "@b5p/pair-execution";
import { canonicalBookHash } from "@b5p/strategy";
import { reducePairGroup } from "../../../packages/pair-execution/src/reducer";
import type { PairGroupEvent } from "../../../packages/pair-execution/src/events";
import type { PairGroupAggregate } from "../../../packages/pair-execution/src/states";
import type { PairActivationResult } from "../src/pair-activation";
import {
  PairParallelDispatchPlanError,
  classifyParallelInitialOutcome,
  classifyParallelLegEvidence,
  commitParallelInitialDispatch,
  parallelInitialEvidenceFacts,
  planParallelInitialDispatch,
  type PairInitialLegClassification,
  type PairParallelInitialDispatchPlan,
} from "../src/pair-parallel-dispatch";
import { decodePaperPairOutboxRequest } from "../src/pair-outbox-dispatcher";
import { paperPairBookReference, type PaperPairEffectEvidence } from "../src/paper-pair-venue";

const now = 1_800_000_000_000;
const groupId = "group-parallel";

function capture(): PairBookCapture {
  const up: ImmutablePairBookLeg = Object.freeze({
    outcome: "UP", tokenId: "up", bookVersion: 11n, connectionEpoch: "epoch", sourceTsMs: now,
    receivedTsMs: now, exchangeHash: null, sourceEventId: "up-event", integrity: "VERIFIED_SNAPSHOT",
    bids: Object.freeze([{ price6: 390_000n, shares6: 2_000_000n }]),
    asks: Object.freeze([{ price6: 400_000n, shares6: 2_000_000n }]),
  });
  const down: ImmutablePairBookLeg = Object.freeze({
    outcome: "DOWN", tokenId: "down", bookVersion: 12n, connectionEpoch: "epoch", sourceTsMs: now,
    receivedTsMs: now, exchangeHash: null, sourceEventId: "down-event", integrity: "VERIFIED_SNAPSHOT",
    bids: Object.freeze([{ price6: 580_000n, shares6: 2_000_000n }]),
    asks: Object.freeze([{ price6: 500_000n, shares6: 2_000_000n }]),
  });
  const contentHash = (leg: ImmutablePairBookLeg) => canonicalBookHash({
    tokenId: leg.tokenId, marketId: "market", bookVersion: leg.bookVersion, connectionEpoch: leg.connectionEpoch,
    sourceTsMs: leg.sourceTsMs, receivedTsMs: leg.receivedTsMs, exchangeHash: leg.exchangeHash,
    sourceEventId: leg.sourceEventId, integrity: leg.integrity,
    bids: leg.bids.map((x) => ({ price: x.price6, size: x.shares6 })),
    asks: leg.asks.map((x) => ({ price: x.price6, size: x.shares6 })),
  });
  const captureHash = pairCaptureHash({
    marketId: "market", conditionId: "condition", capturedAtMs: now, captureSequence: 4n,
    up: { ...up, contentHash: contentHash(up) }, down: { ...down, contentHash: contentHash(down) },
    sourceSkewMs: 0, receiveSkewMs: 0,
  });
  return Object.freeze({
    captureId: pairCaptureId({ captureHash }), marketId: "market", conditionId: "condition",
    capturedAtMs: now, captureSequence: 4n, up, down, sourceSkewMs: 0, receiveSkewMs: 0, captureHash,
  });
}

function activation(): PairActivationResult {
  const c = capture();
  const quoteLeg = (outcome: "UP" | "DOWN", price6: bigint) => Object.freeze({
    outcome,
    tokenId: outcome === "UP" ? "up" : "down",
    orderSide: "BUY" as const,
    requestedGrossShares6: 1_000_000n,
    filledGrossShares6: 1_000_000n,
    receivedNetShares6: 1_000_000n,
    unfilledGrossShares6: 0n,
    levels: Object.freeze([{ price6, grossShares6: 1_000_000n, cashPrincipal6: price6, feeCash6: 0n, feeShares6: 0n, netShares6: 1_000_000n }]),
    principal6: price6,
    feeCash6: 0n,
    feeShares6: 0n,
    worstPrice6: price6,
    averagePrice6: price6,
    fullyExecutable: true,
    bookRef: paperPairBookReference(c, outcome),
  });
  const terms = (outcome: "UP" | "DOWN") => {
    const tokenId = outcome === "UP" ? "up" : "down";
    return Object.freeze({
      outcome, tokenId,
      constraints: Object.freeze({ snapshotId: `constraint-${tokenId}`, tokenId, tickSize6: 10_000n, minimumOrderShares6: 1_000_000n, effectiveAtMs: now, fetchedAtMs: now, source: "test", canonicalHash: `constraint-hash-${tokenId}` }),
      fee: Object.freeze({ snapshotId: `fee-${tokenId}`, tokenId, tokenFeeRatePpm: 0n, convention: "USDC" as const, conventionResolverVersion: "test", effectiveAtMs: now, fetchedAtMs: now, source: "test", canonicalHash: `fee-hash-${tokenId}` }),
    });
  };
  const quote = {
    pairGrossShares6: 1_000_000n,
    up: quoteLeg("UP", 400_000n),
    down: quoteLeg("DOWN", 500_000n),
  };
  return Object.freeze({
    kind: "APPROVED" as const,
    data: Object.freeze({
      schemaVersion: 1 as const,
      kind: "complete_set_pair_activation_v1" as const,
      groupId,
      scheduledDueMs: now,
      actualDispatchMs: now,
      cutoff: { receiveSequence: 1n, dataCutoffEventId: "event", dataCutoffEnvelopeId: "envelope" },
      decisionRepresentation: { kind: "REVALIDATE_SIGNAL" as const },
      signalAuthority: { signalCaptureId: "signal", signalCaptureHash: "signal-hash", signalQuoteHash: "quote-hash", approvedGrossShares6: 1_000_000n, policyHash: "policy", rulesHash: "rules", permitExpiresAtMs: now + 1_000 },
      activationCapture: c,
      currentTerms: { up: terms("UP"), down: terms("DOWN") },
      termChanges: [],
      selectedGrossShares6: 1_000_000n,
      quote,
      riskDecision: { kind: "APPROVED" as const, permitId: "permit", approvedQuoteHash: "activation-quote", policyHash: "policy", portfolioHash: "portfolio", maximumReservedCash6: 1_000_000n, maximumResidualLoss6: 1_000_000n, upOnlyWorstLoss6: 1_000_000n, downOnlyWorstLoss6: 1_000_000n, maximumLockedLossAfterCompletion6: 0n, maximumComplementCashDebit6: 1_000_000n, issuedAtMs: now, expiresAtMs: now + 1_000 },
      gateResult: { kind: "APPROVED" as const, reasons: [] },
    }),
  }) as unknown as PairActivationResult;
}

function planInput() {
  return {
    activation: activation(),
    groupId,
    actionSequence: 1,
    expectedEventSequence: 4,
    activationDecisionId: "activation-decision",
    activationRiskDecisionId: "activation-risk",
    shareLot6: 1_000_000n,
    notBeforeMs: now,
    deadlineMs: now + 1_000,
    createdAtMs: now,
  };
}

function evidence(
  plan: PairParallelInitialDispatchPlan,
  outcome: "UP" | "DOWN",
  kind: "FILLED" | "NO_FILL" | "REJECTED" | "UNKNOWN" | "PARTIAL_CANCELED",
  netShares6 = 1_000_000n,
): PaperPairEffectEvidence {
  const leg = outcome === "UP" ? plan.legs[0] : plan.legs[1];
  const directQuote = Object.freeze({
    side: "BUY" as const,
    requestedGrossShares6: 1_000_000n,
    filledGrossShares6: kind === "PARTIAL_CANCELED" ? 500_000n : 1_000_000n,
    receivedNetShares6: kind === "PARTIAL_CANCELED" ? 500_000n : netShares6,
    unfilledGrossShares6: kind === "PARTIAL_CANCELED" ? 500_000n : 0n,
    levels: Object.freeze([]),
    principal6: 400_000n,
    feeCash6: 0n,
    feeShares6: 0n,
    topOfBookPrice6: 400_000n,
    worstPrice6: 400_000n,
    averagePrice6: 400_000n,
    impactFromTop6: 0n,
    fullyExecutable: kind !== "PARTIAL_CANCELED",
    bookRef: leg.request.leg.bookRef,
  });
  const result = kind === "FILLED" ? { kind, quote: directQuote } as const
    : kind === "PARTIAL_CANCELED" ? { kind, quote: directQuote } as const
      : kind === "NO_FILL" ? { kind, code: "NO_FILL_LIMIT" as const } as const
        : kind === "REJECTED" ? { kind, code: "REJECTED_SCRIPTED" as const, detail: "test" } as const
          : { kind, reason: "UNKNOWN_SIMULATED_TIMEOUT" as const } as const;
  const state = kind === "REJECTED" ? "TERMINAL_REJECTED"
    : kind === "UNKNOWN" ? "OUTCOME_UNKNOWN"
      : kind;
  return Object.freeze({
    evidenceId: `evidence-${outcome}-${kind}`,
    effectId: leg.effect.id,
    clientOperationId: leg.effect.clientOperationId,
    idempotencyKey: leg.effect.idempotencyKey,
    requestHash: leg.effect.requestHash,
    captureId: leg.request.capture.captureId,
    operationKind: "INITIAL_FOK",
    state,
    result,
    resultHash: canonicalObjectHash(result),
    computedAtMs: now + 1,
  });
}

describe("parallel initial dispatch planning", () => {
  it("builds one deterministic action with UP ordinal 0 and DOWN ordinal 1 before either effect is exposed", () => {
    const first = planParallelInitialDispatch(planInput());
    const replayed = planParallelInitialDispatch(planInput());
    expect(replayed).toEqual(first);
    expect(first.planHash).toBe(replayed.planHash);
    expect(first.action.actionKind).toBe("INITIAL_PARALLEL");
    expect(first.effects).toHaveLength(2);
    expect(first.legs.map((leg) => [leg.outcome, leg.ordinal, leg.effect.effectOrdinal])).toEqual([
      ["UP", 0, 0], ["DOWN", 1, 1],
    ]);
    expect(new Set(first.effects.map((effect) => effect.actionIntentId))).toEqual(new Set([first.action.id]));
    expect(first.facts.map((fact) => fact.type)).toEqual([
      "PAIR_ACTIVATION_APPROVED", "PAIR_LEG_PLANNED", "PAIR_LEG_PLANNED",
      "PAIR_LEG_EFFECT_ENQUEUED", "PAIR_LEG_EFFECT_ENQUEUED",
    ]);
    for (const leg of first.legs) {
      expect(decodePaperPairOutboxRequest({ ...leg.effect, groupId, state: "PENDING", claimToken: null, claimedAtMs: null, claimExpiresAtMs: null, attemptCount: 0, resultEvidenceId: null, lastErrorCode: null, updatedAtMs: now })).toEqual(leg.request);
    }
  });

  it("calls the persistence hook once and returns both children only after the atomic commit", async () => {
    let committed = false;
    const commitInitialParallel = vi.fn(async (plan: PairParallelInitialDispatchPlan) => {
      expect(plan.effects).toHaveLength(2);
      expect(committed).toBe(false);
      committed = true;
      return { kind: "COMMITTED" as const };
    });
    const result = await commitParallelInitialDispatch(planInput(), { commitInitialParallel });
    expect(committed).toBe(true);
    expect(commitInitialParallel).toHaveBeenCalledTimes(1);
    expect(result.committedEffects).toHaveLength(2);
    expect(result.committedEffects).toEqual(result.plan.effects);

    await expect(commitParallelInitialDispatch(planInput(), {
      commitInitialParallel: async () => ({ kind: "DUPLICATE", planHash: "different" }),
    })).rejects.toBeInstanceOf(PairParallelDispatchPlanError);
  });
});

describe("parallel initial result classification", () => {
  it("retains the committed sibling and does not classify on the first ordinary terminal result", () => {
    const p = planParallelInitialDispatch(planInput());
    const up = classifyParallelLegEvidence(p.legs[0], evidence(p, "UP", "FILLED"));
    expect(classifyParallelInitialOutcome({ plan: p, up, down: null })).toEqual({
      kind: "AWAITING_SIBLING", retainedEffectId: p.legs[1].effect.id, siblingAction: "RETAIN_COMMITTED_EFFECT",
    });
    const downNoFill = classifyParallelLegEvidence(p.legs[1], evidence(p, "DOWN", "NO_FILL"));
    expect(classifyParallelInitialOutcome({ plan: p, up: null, down: downNoFill })).toEqual({
      kind: "AWAITING_SIBLING", retainedEffectId: p.legs[0].effect.id, siblingAction: "RETAIN_COMMITTED_EFFECT",
    });
  });

  it("classifies both-fill, zero-fill, unequal holdings, and any unknown independently", () => {
    const p = planParallelInitialDispatch(planInput());
    const classify = (outcome: "UP" | "DOWN", kind: Parameters<typeof evidence>[2], net?: bigint) =>
      classifyParallelLegEvidence(outcome === "UP" ? p.legs[0] : p.legs[1], evidence(p, outcome, kind, net));
    const filledUp = classify("UP", "FILLED");
    const filledDown = classify("DOWN", "FILLED");
    const noUp = classify("UP", "NO_FILL");
    const rejectedDown = classify("DOWN", "REJECTED");
    const unknownUp = classify("UP", "UNKNOWN");
    expect(classifyParallelInitialOutcome({ plan: p, up: filledUp, down: filledDown })).toEqual({ kind: "PAIRED", matchedShares6: 1_000_000n });
    expect(classifyParallelInitialOutcome({ plan: p, up: noUp, down: rejectedDown })).toEqual({ kind: "NO_INITIAL_FILL" });
    expect(classifyParallelInitialOutcome({ plan: p, up: filledUp, down: rejectedDown })).toEqual({ kind: "RESIDUAL", upHeldShares6: 1_000_000n, downHeldShares6: 0n });
    const unequalDown = classify("DOWN", "FILLED", 900_000n);
    expect(classifyParallelInitialOutcome({ plan: p, up: filledUp, down: unequalDown })).toEqual({ kind: "RESIDUAL", upHeldShares6: 1_000_000n, downHeldShares6: 900_000n });
    expect(classifyParallelInitialOutcome({ plan: p, up: unknownUp, down: null })).toEqual({ kind: "OUTCOME_UNKNOWN", siblingAction: "RETAIN_COMMITTED_EFFECT" });
    expect(classifyParallelInitialOutcome({ plan: p, up: unknownUp, down: filledDown })).toEqual({ kind: "OUTCOME_UNKNOWN", siblingAction: "NONE" });
  });

  it("turns an impossible initial FOK partial into deterministic reducer facts that enter MANUAL_REVIEW", () => {
    const p = planParallelInitialDispatch(planInput());
    const group = groupId as PairGroupId;
    const created: PairGroupEvent = {
      type: "PAIR_GROUP_CREATED", schemaVersion: 1, eventId: "create" as never, groupId: group,
      causationId: "create", occurredAtMs: now - 1,
      payload: {
        dispatchModel: "PARALLEL", upLegId: pairLegId(group, "UP"), downLegId: pairLegId(group, "DOWN"),
        targetGrossShares6: 1_000_000n, approvedCashCap6: 1_000_000n, approvedResidualLoss6: 1_000_000n,
      },
    };
    let aggregate: PairGroupAggregate | null = null;
    const apply = (event: PairGroupEvent) => {
      const result = reducePairGroup(aggregate, event);
      expect(result.kind).toBe("APPLIED");
      aggregate = result.aggregate;
    };
    apply(created);
    apply({ type: "PAIR_ACTIVATION_STARTED", schemaVersion: 1, eventId: "start" as never, groupId: group, causationId: "start", occurredAtMs: now, payload: {} });
    for (const fact of p.facts) apply({ ...fact, schemaVersion: 1 } as PairGroupEvent);
    const partial = evidence(p, "UP", "PARTIAL_CANCELED");
    const first = parallelInitialEvidenceFacts({ plan: p, outcome: "UP", evidence: partial, occurredAtMs: now + 2 });
    const replayed = parallelInitialEvidenceFacts({ plan: p, outcome: "UP", evidence: partial, occurredAtMs: now + 2 });
    expect(replayed).toEqual(first);
    expect(first).toHaveLength(1);
    apply({ ...first[0]!, schemaVersion: 1 } as PairGroupEvent);
    expect(aggregate).toMatchObject({
      state: "MANUAL_REVIEW",
      reconciliationStatus: "MISMATCH",
      haltReason: "INITIAL_FOK_EVIDENCE_MISMATCH",
      invariantBreachCodes: expect.arrayContaining(["INITIAL_FOK_NOT_ALL_OR_ZERO"]),
    });
    const partialClassification: PairInitialLegClassification = classifyParallelLegEvidence(p.legs[0], partial);
    expect(classifyParallelInitialOutcome({ plan: p, up: partialClassification, down: null })).toEqual({
      kind: "MANUAL_REVIEW", breachCode: "INITIAL_FOK_NOT_ALL_OR_ZERO",
    });
  });
});

import { describe, expect, it } from "vitest";
import type { PairGroupId, PairOutcome, PairSettlementPolicy } from "../src/contracts";
import { createInventoryLot, flattenJournals, inventoryHoldings, replayPairLedger, type PairInventoryConsumption, type PairInventoryLot } from "../src/ledger";
import {
  applyPairResolution,
  applyVirtualMergeEvidence,
  planPairSettlement,
  type PairSettlementPlan,
  type PlanPairSettlementInput,
} from "../src/settlement-integration";
import type { PairSettlementRecord } from "../src/settlement";

const groupId = "pgrp-settlement-integration" as PairGroupId;

function lot(outcome: PairOutcome, shares6: bigint): PairInventoryLot {
  return createInventoryLot({
    lotId: `lot-${outcome}`,
    groupId,
    marketId: "market",
    tokenId: outcome === "UP" ? "up-token" : "down-token",
    outcome,
    sourceFillId: `fill-${outcome}`,
    grossShares6: shares6,
    netShares6: shares6,
    principalCost6: shares6 * (outcome === "UP" ? 42n : 48n) / 100n,
    cashFee6: 0n,
    shareFee6: 0n,
    acquiredAtMs: outcome === "UP" ? 1 : 2,
  });
}

function planning(
  policy: PairSettlementPolicy,
  lots: readonly PairInventoryLot[],
  overrides: Partial<PlanPairSettlementInput> = {},
): PlanPairSettlementInput {
  return {
    groupId,
    pairAccountId: "pair-account",
    groupState: "PAIRED",
    policy,
    upTokenId: "up-token",
    downTokenId: "down-token",
    lots,
    existingConsumptions: [],
    existingSettlements: [],
    existingEffectIds: [],
    decisionSequence: 7,
    decisionAtMs: 10_000,
    modeledDelayMs: 500,
    unknownResultTimeoutMs: 2_000,
    settlementCost6: 5_000n,
    settlementCashReserved6: 7_000n,
    ...overrides,
  };
}

function mergePlan(lots: readonly PairInventoryLot[]): Extract<PairSettlementPlan, { readonly kind: "MERGE_READY" }> {
  const result = planPairSettlement(planning("PAPER_VIRTUAL_MERGE", lots));
  if (result.kind !== "MERGE_READY") throw new Error(`unexpected ${result.kind}`);
  return result;
}

function mergeEvidence(
  plan: Extract<PairSettlementPlan, { readonly kind: "MERGE_READY" }>,
  lots: readonly PairInventoryLot[],
  status: "CONFIRMED" | "FAILED" | "EXPIRED" | "UNKNOWN",
  existingConsumptions: readonly PairInventoryConsumption[] = [],
  existingSettlements: readonly PairSettlementRecord[] = [],
) {
  return applyVirtualMergeEvidence({
    plan,
    pairAccountId: "pair-account",
    upTokenId: "up-token",
    downTokenId: "down-token",
    lots,
    existingConsumptions,
    existingSettlements,
    status,
    evidenceKey: `merge-${status}`,
    occurredAtMs: 11_000,
    recordedAtMs: 11_001,
  });
}

function resolution(
  lots: readonly PairInventoryLot[],
  winner: PairOutcome,
  existingConsumptions: readonly PairInventoryConsumption[] = [],
  existingSettlements: readonly PairSettlementRecord[] = [],
) {
  return applyPairResolution({
    groupId,
    pairAccountId: "pair-account",
    upTokenId: "up-token",
    downTokenId: "down-token",
    lots,
    existingConsumptions,
    existingSettlements,
    resolutionId: `resolution-${winner}`,
    evidenceKey: `resolution-evidence-${winner}`,
    source: "CHAINLINK",
    sourceAuthoritative: true,
    winner,
    settlementCashReserved6: 7_000n,
    occurredAtMs: 20_000,
    recordedAtMs: 20_001,
  });
}

describe("settlement policy planning", () => {
  it("HOLD_TO_RESOLUTION creates no effect and waits for authoritative evidence", () => {
    const lots = [lot("UP", 1_000_000n), lot("DOWN", 1_000_000n)];
    expect(planPairSettlement(planning("HOLD_TO_RESOLUTION", lots))).toEqual({
      kind: "AWAITING_RESOLUTION",
      groupId,
      reason: "HOLD_POLICY",
      effects: [],
    });
  });

  it("virtual merge creates exactly one deterministic delayed effect only for paired inventory", () => {
    const lots = [lot("UP", 1_000_000n), lot("DOWN", 1_000_000n)];
    const first = mergePlan(lots);
    const restarted = mergePlan(lots);
    expect(restarted).toEqual(first);
    expect(first.effects).toHaveLength(1);
    expect(first.effects[0]).toMatchObject({
      actionKind: "PAPER_VIRTUAL_MERGE",
      matchedShares6: 1_000_000n,
      notBeforeMs: 10_500,
      deadlineMs: 12_500,
      effectOrdinal: 0,
      increasesExposure: false,
    });
    expect(planPairSettlement(planning("PAPER_VIRTUAL_MERGE", lots, { existingEffectIds: [first.effects[0].effectId] }))).toEqual({
      kind: "MERGE_PENDING",
      groupId,
      effectId: first.effects[0].effectId,
      effects: [],
    });
    expect(planPairSettlement(planning("PAPER_VIRTUAL_MERGE", lots, { groupState: "RESIDUAL" }))).toEqual({
      kind: "REJECTED",
      code: "GROUP_NOT_PAIRED",
      effects: [],
    });
    expect(planPairSettlement(planning("PAPER_VIRTUAL_MERGE", [lot("UP", 2_000_000n), lot("DOWN", 1_000_000n)]))).toEqual({
      kind: "REJECTED",
      code: "PAIRED_INVENTORY_MISMATCH",
      effects: [],
    });
  });
});

describe("durable virtual merge evidence", () => {
  it("confirmed merge consumes matched lots and posts payout plus explicit cost exactly once", () => {
    const lots = [lot("UP", 1_000_000n), lot("DOWN", 1_000_000n)];
    const plan = mergePlan(lots);
    const applied = mergeEvidence(plan, lots, "CONFIRMED");
    expect(applied.kind).toBe("MERGE_CONFIRMED");
    if (applied.kind !== "MERGE_CONFIRMED") return;
    expect(applied).toMatchObject({ matchedShares6: 1_000_000n, cashCredit6: 995_000n, reservationReleased6: 7_000n });
    expect(inventoryHoldings(lots, applied.consumptions, groupId)).toEqual({ "up-token": 0n, "down-token": 0n });
    const ledger = replayPairLedger(flattenJournals(applied.journals));
    expect(ledger.accountCash6).toBe(995_000n);
    expect(ledger.realizedRevenue6).toBe(1_000_000n);
    const duplicate = mergeEvidence(plan, lots, "CONFIRMED", applied.consumptions, [applied.record]);
    expect(duplicate).toEqual({ kind: "DUPLICATE", record: applied.record });
  });

  it.each(["FAILED", "EXPIRED"] as const)("%s retains tokens and moves to authoritative resolution", (status) => {
    const lots = [lot("UP", 1_000_000n), lot("DOWN", 1_000_000n)];
    const result = mergeEvidence(mergePlan(lots), lots, status);
    expect(result.kind).toBe("AWAITING_RESOLUTION");
    if (result.kind !== "AWAITING_RESOLUTION") return;
    expect(result).toMatchObject({ reason: status, consumptions: [], reservationReleased6: 7_000n });
    expect(inventoryHoldings(lots, result.consumptions, groupId)).toEqual({ "up-token": 1_000_000n, "down-token": 1_000_000n });
  });

  it("unknown retains tokens and reservation and blocks both replanning and resolution", () => {
    const lots = [lot("UP", 1_000_000n), lot("DOWN", 1_000_000n)];
    const plan = mergePlan(lots);
    const unknown = mergeEvidence(plan, lots, "UNKNOWN");
    expect(unknown.kind).toBe("MERGE_BLOCKED_UNKNOWN");
    if (unknown.kind !== "MERGE_BLOCKED_UNKNOWN") return;
    expect(unknown).toMatchObject({ consumptions: [], journals: [], reservationReleased6: 0n });
    expect(planPairSettlement(planning("PAPER_VIRTUAL_MERGE", lots, { existingSettlements: [unknown.record] }))).toEqual({
      kind: "MERGE_BLOCKED_UNKNOWN",
      groupId,
      effectId: plan.effects[0].effectId,
      effects: [],
    });
    expect(resolution(lots, "UP", [], [unknown.record])).toEqual({
      kind: "BLOCKED_MERGE_UNKNOWN",
      effectId: plan.effects[0].effectId,
    });
  });
});

describe("authoritative resolution integration", () => {
  it("consumes winning and losing lots and posts the authoritative payout once", () => {
    const lots = [lot("UP", 2_000_000n), lot("DOWN", 1_000_000n)];
    const applied = resolution(lots, "UP");
    expect(applied.kind).toBe("RESOLUTION_APPLIED");
    if (applied.kind !== "RESOLUTION_APPLIED") return;
    expect(applied).toMatchObject({ payout6: 2_000_000n, reservationReleased6: 7_000n });
    expect(inventoryHoldings(lots, applied.consumptions, groupId)).toEqual({ "up-token": 0n, "down-token": 0n });
    const duplicate = resolution(lots, "UP", applied.consumptions, [applied.record]);
    expect(duplicate).toEqual({ kind: "DUPLICATE", record: applied.record });
  });

  it("merge then resolution credits only remaining winning residual and never merged units", () => {
    const lots = [lot("UP", 2_000_000n), lot("DOWN", 1_000_000n)];
    const pairedForPlan = [lot("UP", 1_000_000n), lot("DOWN", 1_000_000n)];
    const plan = mergePlan(pairedForPlan);
    const merged = mergeEvidence(plan, lots, "CONFIRMED");
    expect(merged.kind).toBe("MERGE_CONFIRMED");
    if (merged.kind !== "MERGE_CONFIRMED") return;
    const resolved = resolution(lots, "UP", merged.consumptions, [merged.record]);
    expect(resolved.kind).toBe("RESOLUTION_APPLIED");
    if (resolved.kind !== "RESOLUTION_APPLIED") return;
    expect(resolved.payout6).toBe(1_000_000n);
    expect(merged.cashCredit6 + resolved.payout6).toBe(1_995_000n);
  });

  it("a fully merged group ignores later resolution without another credit", () => {
    const lots = [lot("UP", 1_000_000n), lot("DOWN", 1_000_000n)];
    const plan = mergePlan(lots);
    const merged = mergeEvidence(plan, lots, "CONFIRMED");
    expect(merged.kind).toBe("MERGE_CONFIRMED");
    if (merged.kind !== "MERGE_CONFIRMED") return;
    expect(resolution(lots, "DOWN", merged.consumptions, [merged.record])).toEqual({
      kind: "ALREADY_SETTLED",
      operationId: plan.effects[0].effectId,
      payout6: 0n,
    });
  });

  it("a confirmed merge with residual inventory waits for resolution and never enqueues a second merge", () => {
    const lots = [lot("UP", 2_000_000n), lot("DOWN", 1_000_000n)];
    const plan = mergePlan([lot("UP", 1_000_000n), lot("DOWN", 1_000_000n)]);
    const merged = mergeEvidence(plan, lots, "CONFIRMED");
    expect(merged.kind).toBe("MERGE_CONFIRMED");
    if (merged.kind !== "MERGE_CONFIRMED") return;
    expect(planPairSettlement(planning("PAPER_VIRTUAL_MERGE", lots, {
      groupState: "AWAITING_RESOLUTION",
      existingConsumptions: merged.consumptions,
      existingSettlements: [merged.record],
    }))).toEqual({
      kind: "AWAITING_RESOLUTION",
      groupId,
      reason: "MERGE_CONFIRMED_RESIDUAL",
      effects: [],
    });
  });

  it("rejects non-authoritative results and reconstructs deterministic resolution journals after restart", () => {
    const lots = [lot("UP", 1_000_000n), lot("DOWN", 1_000_000n)];
    const invalid = applyPairResolution({
      ...planning("HOLD_TO_RESOLUTION", lots),
      resolutionId: "resolution-invalid",
      evidenceKey: "invalid",
      source: "UI",
      sourceAuthoritative: false,
      winner: "UP",
      occurredAtMs: 20_000,
      recordedAtMs: 20_001,
    });
    expect(invalid).toEqual({ kind: "REJECTED", code: "RESOLUTION_SOURCE_NON_AUTHORITATIVE" });
    const before = resolution(lots, "DOWN");
    const after = resolution(lots, "DOWN");
    expect(after).toEqual(before);
  });
});

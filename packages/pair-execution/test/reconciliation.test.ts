import { describe, expect, it } from "vitest";
import type { PairGroupId, PairLegId } from "../src/contracts";
import {
  buyFillJournal,
  createInventoryLot,
  flattenJournals,
  reserveCashJournal,
  type JournalContext,
  type PairInventoryConsumption,
} from "../src/ledger";
import {
  comparePairReconciliation,
  type ComparePairReconciliationInput,
  type PairFillReconciliationRecord,
  type PairStoredProjection,
} from "../src/reconciliation";
import type { PairGroupAggregate, PairLegProjection } from "../src/states";

const GROUP = "group-reconcile" as PairGroupId;
const OTHER = "other-group" as PairGroupId;

function context(journalId: string): JournalContext {
  return {
    journalId,
    pairAccountId: "account",
    groupId: GROUP,
    causationEventId: `event-${journalId}`,
    causationKind: journalId,
    occurredAtMs: 1,
    recordedAtMs: 2,
  };
}

function leg(outcome: "UP" | "DOWN", cashDebit6: bigint): PairLegProjection {
  return {
    legId: `${outcome.toLowerCase()}-leg` as PairLegId,
    outcome,
    state: "FILLED",
    requestedGrossShares6: 10n,
    filledGrossShares6: 10n,
    receivedNetShares6: 10n,
    cashDebit6,
    effectId: `${outcome.toLowerCase()}-effect`,
    resultEvidenceKey: `${outcome.toLowerCase()}-result`,
    fillEvidenceKey: `${outcome.toLowerCase()}-fill-evidence`,
    actualDispatchAtMs: 1,
  };
}

function aggregate(overrides: Partial<PairGroupAggregate> = {}): PairGroupAggregate {
  return {
    groupId: GROUP,
    state: "PAIRED",
    stateVersion: 3,
    eventCount: 3,
    dispatchModel: "PARALLEL",
    upLeg: leg("UP", 400n),
    downLeg: leg("DOWN", 500n),
    targetGrossShares6: 10n,
    approvedCashCap6: 900n,
    approvedResidualLoss6: 900n,
    reservedCash6: 0n,
    cashDebits6: 900n,
    cashCredits6: 0n,
    upHeldShares6: 10n,
    downHeldShares6: 10n,
    matchedShares6: 10n,
    residualSide: null,
    residualShares6: 0n,
    currentWorstCaseLoss6: 890n,
    peakWorstCaseLoss6: 890n,
    nextActionAtMs: null,
    recoveryAttempts: 0,
    haltedAtMs: null,
    haltReason: null,
    reconciliationStatus: "PENDING",
    closedAtMs: null,
    settled: false,
    safetyBreachRecorded: false,
    invariantBreachCodes: [],
    appliedEventIds: {},
    appliedDedupeKeys: {},
    ...overrides,
  };
}

function stored(value: PairGroupAggregate): PairStoredProjection {
  return {
    state: value.state,
    stateVersion: value.stateVersion,
    eventCount: value.eventCount,
    reservedCash6: value.reservedCash6,
    cashDebits6: value.cashDebits6,
    cashCredits6: value.cashCredits6,
    upHeldShares6: value.upHeldShares6,
    downHeldShares6: value.downHeldShares6,
    matchedShares6: value.matchedShares6,
    residualShares6: value.residualShares6,
    realizedPnl6: 0n,
  };
}

function baseInput(): ComparePairReconciliationInput {
  const expected = aggregate();
  const lots = [
    createInventoryLot({ lotId: "up-lot", groupId: GROUP, marketId: "market", tokenId: "up", outcome: "UP", sourceFillId: "up-fill", grossShares6: 10n, netShares6: 10n, principalCost6: 400n, cashFee6: 0n, shareFee6: 0n, acquiredAtMs: 1 }),
    createInventoryLot({ lotId: "down-lot", groupId: GROUP, marketId: "market", tokenId: "down", outcome: "DOWN", sourceFillId: "down-fill", grossShares6: 10n, netShares6: 10n, principalCost6: 500n, cashFee6: 0n, shareFee6: 0n, acquiredAtMs: 2 }),
  ];
  const fills: PairFillReconciliationRecord[] = [
    { fillId: "up-fill", evidenceKey: "up-fill-evidence", payloadHash: "up-hash", groupId: GROUP, orderId: "up-order", grossShares6: 10n, netShares6: 10n },
    { fillId: "down-fill", evidenceKey: "down-fill-evidence", payloadHash: "down-hash", groupId: GROUP, orderId: "down-order", grossShares6: 10n, netShares6: 10n },
  ];
  return {
    groupId: GROUP,
    upTokenId: "up",
    downTokenId: "down",
    eventDerived: expected,
    eventSequenceNumbers: [1, 2, 3],
    projection: stored(expected),
    ledgerEntries: flattenJournals([
      reserveCashJournal(context("reserve"), 900n),
      buyFillJournal({ context: context("up-buy"), tokenId: "up", outcome: "UP", principal6: 400n, cashFee6: 0n, grossShares6: 10n, shareFee6: 0n, netShares6: 10n, inventoryLotId: "up-lot", orderId: "up-order", fillId: "up-fill" }),
      buyFillJournal({ context: context("down-buy"), tokenId: "down", outcome: "DOWN", principal6: 500n, cashFee6: 0n, grossShares6: 10n, shareFee6: 0n, netShares6: 10n, inventoryLotId: "down-lot", orderId: "down-order", fillId: "down-fill" }),
    ]),
    lots,
    consumptions: [],
    orders: [
      { orderId: "up-order", groupId: GROUP, requestedShares6: 10n },
      { orderId: "down-order", groupId: GROUP, requestedShares6: 10n },
    ],
    fills,
    effects: [],
    adapterObservations: [],
    nowMs: 100,
  };
}

function codes(input: ComparePairReconciliationInput): readonly string[] {
  return comparePairReconciliation(input).diffs.map(({ code }) => code);
}

describe("BPAIR-043 pure reconciliation comparator", () => {
  it("returns healthy only when events, ledger, lots, projection, orders, and fills agree", () => {
    expect(comparePairReconciliation(baseInput())).toMatchObject({
      status: "HEALTHY",
      healthy: true,
      schedulingAllowed: true,
      projectionRebuildRequired: false,
      retainReservation: false,
      diffs: [],
    });
  });

  it("classifies projection-only and ledger-derived P&L differences as rebuildable", () => {
    const input = baseInput();
    const result = comparePairReconciliation({
      ...input,
      projection: { ...input.projection, upHeldShares6: 9n, matchedShares6: 9n, realizedPnl6: 1n },
    });
    expect(result).toMatchObject({ status: "REPAIRABLE", healthy: false, projectionRebuildRequired: true });
    expect(result.diffs).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "PROJECTION_UP_HOLDINGS_MISMATCH", action: "REBUILD_PROJECTION", autoRepairable: true }),
      expect.objectContaining({ code: "PROJECTION_REALIZED_PNL_MISMATCH", action: "REBUILD_PROJECTION", autoRepairable: true }),
    ]));
  });

  it("fails closed on an event sequence gap", () => {
    const input = baseInput();
    const result = comparePairReconciliation({ ...input, eventSequenceNumbers: [1, 3] });
    expect(result).toMatchObject({ status: "MANUAL_REVIEW", schedulingAllowed: false });
    expect(result.diffs).toContainEqual(expect.objectContaining({ code: "EVENT_SEQUENCE_GAP", severity: "CRITICAL", autoRepairable: false }));
  });

  it("diagnoses an idempotent duplicate fill but rejects a conflicting payload", () => {
    const input = baseInput();
    const duplicate = input.fills[0];
    if (duplicate === undefined) throw new Error("fixture missing fill");
    const same = comparePairReconciliation({ ...input, fills: [...input.fills, { ...duplicate }] });
    expect(same.status).toBe("HEALTHY");
    expect(same.diffs).toContainEqual(expect.objectContaining({ code: "DUPLICATE_FILL_SAME_PAYLOAD", severity: "DIAGNOSTIC" }));

    const conflicting = comparePairReconciliation({ ...input, fills: [...input.fills, { ...duplicate, payloadHash: "different" }] });
    expect(conflicting.status).toBe("MANUAL_REVIEW");
    expect(conflicting.diffs).toContainEqual(expect.objectContaining({ code: "DUPLICATE_FILL_DIFFERENT_PAYLOAD", severity: "CRITICAL" }));
  });

  it("marks missing/duplicate fill ledger causation and invalid quantities critical", () => {
    const input = baseInput();
    const withoutDownLedger = input.ledgerEntries.filter(({ fillId }) => fillId !== "down-fill");
    expect(codes({ ...input, ledgerEntries: withoutDownLedger })).toContain("FILL_MISSING_LEDGER_CAUSATION");

    const upEntries = input.ledgerEntries.filter(({ fillId }) => fillId === "up-fill").map((entry) => ({ ...entry, journalId: "duplicate-up-buy", entryId: `duplicate:${entry.entryId}` as typeof entry.entryId }));
    expect(codes({ ...input, ledgerEntries: [...input.ledgerEntries, ...upEntries] })).toContain("FILL_DUPLICATE_LEDGER_CAUSATION");

    const badFill = input.fills.map((fill) => fill.fillId === "up-fill" ? { ...fill, grossShares6: 11n } : fill);
    expect(codes({ ...input, fills: badFill })).toContain("FILL_QUANTITY_INVALID");
  });

  it("marks wrong group/order references and an unbalanced journal critical", () => {
    const input = baseInput();
    const wrongGroup = input.ledgerEntries.map((entry) => entry.fillId === "up-fill" ? { ...entry, groupId: OTHER } : entry);
    const wrongCodes = codes({ ...input, ledgerEntries: wrongGroup });
    expect(wrongCodes).toContain("LEDGER_REFERENCES_WRONG_GROUP");
    expect(wrongCodes).toContain("EVENT_LEDGER_UP_HOLDINGS_MISMATCH");

    const corrupt = input.ledgerEntries.map((entry, index) => index === 0 ? { ...entry, amount6: entry.amount6 + 1n } : entry);
    expect(codes({ ...input, ledgerEntries: corrupt })).toContain("UNBALANCED_LEDGER_JOURNAL");
  });

  it("treats lot divergence and negative reconstructed inventory as source mismatches", () => {
    const input = baseInput();
    expect(codes({ ...input, lots: input.lots.filter(({ tokenId }) => tokenId !== "down") })).toContain("LOT_DOWN_HOLDINGS_MISMATCH");

    const over: PairInventoryConsumption = {
      consumptionId: "over", lotId: "up-lot", groupId: GROUP, eventId: "event-over",
      consumptionKind: "RESOLUTION", shares6: 11n, allocatedPrincipalCost6: 0n,
      allocatedBuyCashFee6: 0n, createdAtMs: 1,
    };
    expect(codes({ ...input, consumptions: [over] })).toContain("NEGATIVE_RECONSTRUCTED_INVENTORY");
  });

  it("retains reservation for claimed unknown effects and escalates after the deadline", () => {
    const input = baseInput();
    const effect = { effectId: "effect", state: "CLAIMED" as const, claimToken: "claim", deadlineMs: 200, resultEvidenceKey: null };
    const pending = comparePairReconciliation({ ...input, effects: [effect], adapterObservations: [{ effectId: "effect", status: "ABSENT", evidenceKey: null, payloadHash: null }] });
    expect(pending).toMatchObject({ status: "PENDING_OBSERVATION", retainReservation: true, schedulingAllowed: false });
    expect(pending.diffs).toContainEqual(expect.objectContaining({ code: "UNKNOWN_EFFECT_REQUIRES_OBSERVATION", action: "RETAIN_AND_OBSERVE" }));

    const expired = comparePairReconciliation({ ...input, nowMs: 201, effects: [effect] });
    expect(expired.status).toBe("MANUAL_REVIEW");
    expect(expired.diffs).toContainEqual(expect.objectContaining({ code: "UNKNOWN_EFFECT_PAST_DEADLINE" }));
  });

  it("identifies an unclaimed pending effect as safe to claim exactly once", () => {
    const input = baseInput();
    const result = comparePairReconciliation({
      ...input,
      effects: [{ effectId: "pending", state: "PENDING", claimToken: null, deadlineMs: 200, resultEvidenceKey: null }],
    });
    expect(result.status).toBe("HEALTHY");
    expect(result.diffs).toContainEqual(expect.objectContaining({ code: "PENDING_EFFECT_SAFE_TO_CLAIM", action: "SAFE_TO_CLAIM" }));
  });

  it("requires manual review for adapter evidence divergence and closed reservation", () => {
    const input = baseInput();
    const divergence = comparePairReconciliation({
      ...input,
      effects: [{ effectId: "done", state: "TERMINAL", claimToken: "claim", deadlineMs: 10, resultEvidenceKey: "stored" }],
      adapterObservations: [{ effectId: "done", status: "FILLED", evidenceKey: "adapter", payloadHash: "hash" }],
    });
    expect(divergence.diffs).toContainEqual(expect.objectContaining({ code: "ADAPTER_EVIDENCE_DIVERGENCE", severity: "CRITICAL" }));

    const closed = aggregate({ state: "RECONCILED_SETTLED", reservedCash6: 1n, reconciliationStatus: "HEALTHY", settled: true });
    const closedInput = { ...input, eventDerived: closed, projection: stored(closed) };
    expect(codes(closedInput)).toContain("CLOSED_GROUP_RESERVATION_NONZERO");
  });
});

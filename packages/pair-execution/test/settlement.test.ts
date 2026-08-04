import { describe, expect, it } from "vitest";
import type { PairGroupId, PairOutcome } from "../src/contracts";
import {
  createInventoryLot,
  flattenJournals,
  inventoryHoldings,
  replayPairLedger,
  type JournalContext,
  type PairInventoryConsumption,
  type PairInventoryLot,
} from "../src/ledger";
import {
  applyAuthoritativeResolution,
  settleVirtualMerge,
  type AuthoritativeResolutionInput,
  type PairSettlementRecord,
  type VirtualMergeInput,
} from "../src/settlement";

const GROUP = "group-settlement" as PairGroupId;

function lot(outcome: PairOutcome, shares6: bigint, suffix = ""): PairInventoryLot {
  const tokenId = outcome === "UP" ? "up-token" : "down-token";
  return createInventoryLot({
    lotId: `${outcome.toLowerCase()}-lot${suffix}`,
    groupId: GROUP,
    marketId: "market",
    tokenId,
    outcome,
    sourceFillId: `${outcome.toLowerCase()}-fill${suffix}`,
    grossShares6: shares6,
    netShares6: shares6,
    principalCost6: shares6 * 45n / 100n,
    cashFee6: 0n,
    shareFee6: 0n,
    acquiredAtMs: outcome === "UP" ? 1 : 2,
  });
}

function journalContext(journalId: string): JournalContext {
  return {
    journalId,
    pairAccountId: "account",
    groupId: GROUP,
    causationEventId: `event-${journalId}`,
    causationKind: journalId,
    occurredAtMs: 10,
    recordedAtMs: 11,
  };
}

function resolutionInput(
  winner: PairOutcome,
  lots: readonly PairInventoryLot[],
  overrides: Partial<AuthoritativeResolutionInput> = {},
): AuthoritativeResolutionInput {
  return {
    groupId: GROUP,
    upTokenId: "up-token",
    downTokenId: "down-token",
    lots,
    existingConsumptions: [],
    existingSettlements: [],
    eventId: `resolution-event-${winner}`,
    occurredAtMs: 20,
    resolutionId: `resolution-${winner}`,
    evidenceKey: `resolution-evidence-${winner}`,
    source: "CHAINLINK",
    sourceAuthoritative: true,
    winner,
    settlementCashReserved6: 0n,
    journalContext: journalContext(`resolution-journal-${winner}`),
    ...overrides,
  };
}

function mergeInput(
  lots: readonly PairInventoryLot[],
  overrides: Partial<VirtualMergeInput> = {},
): VirtualMergeInput {
  return {
    groupId: GROUP,
    upTokenId: "up-token",
    downTokenId: "down-token",
    lots,
    existingConsumptions: [],
    existingSettlements: [],
    eventId: "merge-event",
    occurredAtMs: 20,
    effectId: "merge-effect",
    evidenceKey: "merge-evidence",
    result: "CONFIRMED",
    settlementCost6: 0n,
    settlementCashReserved6: 0n,
    journalContext: journalContext("merge-journal"),
    ...overrides,
  };
}

describe("BPAIR-042 hold-to-authoritative-resolution", () => {
  it("pays an equal complete set identically whichever outcome wins", () => {
    const lots = [lot("UP", 1_000_000n), lot("DOWN", 1_000_000n)];
    for (const winner of ["UP", "DOWN"] as const) {
      const result = applyAuthoritativeResolution(resolutionInput(winner, lots));
      expect(result.kind).toBe("APPLIED");
      if (result.kind !== "APPLIED") continue;
      expect(result.payout6).toBe(1_000_000n);
      expect(inventoryHoldings(lots, result.consumptions, GROUP)).toEqual({ "up-token": 0n, "down-token": 0n });
      const ledger = replayPairLedger(flattenJournals(result.journals));
      expect(ledger.tokenInventoryByAsset).toEqual({ "up-token": -1_000_000n, "down-token": -1_000_000n });
      expect(ledger.realizedRevenue6).toBe(1_000_000n);
    }
  });

  it("credits matched payout plus only a winning residual, symmetrically", () => {
    const upResidual = [lot("UP", 2_000_000n), lot("DOWN", 1_000_000n)];
    const upWins = applyAuthoritativeResolution(resolutionInput("UP", upResidual));
    const upLoses = applyAuthoritativeResolution(resolutionInput("DOWN", upResidual, { resolutionId: "down-resolution" }));
    expect(upWins.kind === "APPLIED" ? upWins.payout6 : null).toBe(2_000_000n);
    expect(upLoses.kind === "APPLIED" ? upLoses.payout6 : null).toBe(1_000_000n);

    const downResidual = [lot("UP", 1_000_000n), lot("DOWN", 2_000_000n)];
    const downWins = applyAuthoritativeResolution(resolutionInput("DOWN", downResidual));
    const downLoses = applyAuthoritativeResolution(resolutionInput("UP", downResidual, { resolutionId: "up-resolution-2" }));
    expect(downWins.kind === "APPLIED" ? downWins.payout6 : null).toBe(2_000_000n);
    expect(downLoses.kind === "APPLIED" ? downLoses.payout6 : null).toBe(1_000_000n);
  });

  it("deduplicates the authoritative resolution and rejects conflicting/non-authoritative evidence", () => {
    const lots = [lot("UP", 1_000_000n), lot("DOWN", 1_000_000n)];
    const applied = applyAuthoritativeResolution(resolutionInput("UP", lots));
    expect(applied.kind).toBe("APPLIED");
    if (applied.kind !== "APPLIED") return;
    const duplicate = applyAuthoritativeResolution(resolutionInput("UP", lots, { existingSettlements: [applied.record] }));
    expect(duplicate).toEqual({ kind: "DUPLICATE", record: applied.record });
    expect(applyAuthoritativeResolution(resolutionInput("DOWN", lots, {
      resolutionId: applied.record.operationId,
      existingSettlements: [applied.record],
    }))).toEqual({ kind: "REJECTED", code: "EVIDENCE_CONFLICT" });
    expect(applyAuthoritativeResolution(resolutionInput("UP", lots, {
      resolutionId: "different-resolution",
      existingSettlements: [applied.record],
    }))).toEqual({ kind: "REJECTED", code: "CONFLICTING_RESOLUTION" });
    expect(applyAuthoritativeResolution(resolutionInput("UP", lots, { source: "UI", sourceAuthoritative: false }))).toEqual({ kind: "REJECTED", code: "RESOLUTION_SOURCE_NON_AUTHORITATIVE" });
  });

  it("releases a settlement reservation exactly once as a separate balanced journal", () => {
    const result = applyAuthoritativeResolution(resolutionInput("UP", [lot("UP", 1n), lot("DOWN", 1n)], {
      settlementCashReserved6: 10n,
      releaseJournalContext: journalContext("resolution-release"),
    }));
    expect(result.kind).toBe("APPLIED");
    if (result.kind !== "APPLIED") return;
    expect(result.journals).toHaveLength(2);
    const projection = replayPairLedger(flattenJournals(result.journals));
    expect(projection.cashReserved6).toBe(-10n);
    expect(projection.accountCash6).toBe(1n);
  });
});

describe("BPAIR-042 virtual merge", () => {
  it("debits both tokens and credits an equal matched quantity once", () => {
    const lots = [lot("UP", 1_000_000n), lot("DOWN", 1_000_000n)];
    const result = settleVirtualMerge(mergeInput(lots));
    expect(result.kind).toBe("CONFIRMED");
    if (result.kind !== "CONFIRMED") return;
    expect(result.matchedShares6).toBe(1_000_000n);
    expect(result.cashCredit6).toBe(1_000_000n);
    expect(result.upRemainingShares6).toBe(0n);
    expect(result.downRemainingShares6).toBe(0n);
    expect(result.consumptions.reduce((sum, item) => sum + item.shares6, 0n)).toBe(2_000_000n);
    expect(settleVirtualMerge(mergeInput(lots, { existingSettlements: [result.record] }))).toEqual({ kind: "DUPLICATE", record: result.record });
  });

  it("consumes only the matched minimum and leaves explicit residual inventory", () => {
    const lots = [lot("UP", 2_000_000n), lot("DOWN", 1_000_000n)];
    const result = settleVirtualMerge(mergeInput(lots));
    expect(result.kind).toBe("CONFIRMED");
    if (result.kind !== "CONFIRMED") return;
    expect(result).toMatchObject({ matchedShares6: 1_000_000n, upRemainingShares6: 1_000_000n, downRemainingShares6: 0n });
    expect(inventoryHoldings(lots, result.consumptions, GROUP)).toEqual({ "up-token": 1_000_000n, "down-token": 0n });
  });

  it("charges exact merge cost from reserved cash and releases only the unused reserve", () => {
    const result = settleVirtualMerge(mergeInput([lot("UP", 1_000_000n), lot("DOWN", 1_000_000n)], {
      settlementCost6: 5_000n,
      settlementCashReserved6: 7_000n,
      releaseJournalContext: journalContext("merge-release"),
    }));
    expect(result.kind).toBe("CONFIRMED");
    if (result.kind !== "CONFIRMED") return;
    expect(result.cashCredit6).toBe(995_000n);
    expect(result.journals).toHaveLength(2);
    const projection = replayPairLedger(flattenJournals(result.journals));
    expect(projection.cashAvailable6).toBe(1_002_000n);
    expect(projection.cashReserved6).toBe(-7_000n);
    expect(projection.accountCash6).toBe(995_000n);
    expect(projection.realizedExpense6).toBe(905_000n);
    expect(projection.terminalRealizedPnl6).toBe(95_000n);
  });

  it("makes failure/unknown exposure-neutral and retains reservation for unknown", () => {
    const lots = [lot("UP", 1n), lot("DOWN", 1n)];
    const failed = settleVirtualMerge(mergeInput(lots, {
      result: "FAILED",
      settlementCashReserved6: 10n,
      releaseJournalContext: journalContext("failed-release"),
    }));
    expect(failed.kind).toBe("FAILED");
    if (failed.kind === "FAILED") {
      expect(failed.consumptions).toEqual([]);
      expect(replayPairLedger(flattenJournals(failed.journals)).accountCash6).toBe(0n);
    }
    const unknown = settleVirtualMerge(mergeInput(lots, { result: "UNKNOWN", settlementCashReserved6: 10n }));
    expect(unknown).toMatchObject({ kind: "UNKNOWN", consumptions: [], journals: [] });
  });

  it("never pays merged token units again when later resolution arrives", () => {
    const lots = [lot("UP", 2_000_000n), lot("DOWN", 1_000_000n)];
    const merged = settleVirtualMerge(mergeInput(lots));
    expect(merged.kind).toBe("CONFIRMED");
    if (merged.kind !== "CONFIRMED") return;
    const resolved = applyAuthoritativeResolution(resolutionInput("UP", lots, {
      existingConsumptions: merged.consumptions,
      existingSettlements: [merged.record],
      resolutionId: "post-merge-resolution",
      eventId: "post-merge-resolution-event",
    }));
    expect(resolved.kind).toBe("APPLIED");
    if (resolved.kind !== "APPLIED") return;
    expect(resolved.payout6).toBe(1_000_000n);
    expect(merged.cashCredit6 + resolved.payout6).toBe(2_000_000n);
    expect(inventoryHoldings(lots, [...merged.consumptions, ...resolved.consumptions], GROUP)).toEqual({ "up-token": 0n, "down-token": 0n });
  });

  it("rejects cost beyond its exact source and conflicting duplicate effect evidence", () => {
    const lots = [lot("UP", 10n), lot("DOWN", 10n)];
    expect(settleVirtualMerge(mergeInput(lots, { settlementCost6: 11n }))).toEqual({ kind: "REJECTED", code: "SETTLEMENT_COST_EXCEEDS_PAYOUT" });
    expect(settleVirtualMerge(mergeInput(lots, { settlementCost6: 2n, settlementCashReserved6: 1n }))).toEqual({ kind: "REJECTED", code: "SETTLEMENT_COST_EXCEEDS_RESERVATION" });
    const prior: PairSettlementRecord = { operationId: "merge-effect", kind: "VIRTUAL_MERGE", status: "CONFIRMED", evidenceKey: "old", upConsumedShares6: 1n, downConsumedShares6: 1n, cashCredit6: 1n, winner: null };
    expect(settleVirtualMerge(mergeInput(lots, { existingSettlements: [prior] }))).toEqual({ kind: "REJECTED", code: "EVIDENCE_CONFLICT" });
  });
});

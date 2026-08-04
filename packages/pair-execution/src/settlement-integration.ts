import type { PairGroupId, PairOutcome, PairSettlementPolicy } from "./contracts";
import { canonicalObjectHash, immutableRequestHash } from "./hashes";
import { effectIdempotencyKey } from "./ids";
import { inventoryHoldings, type JournalContext, type PairInventoryConsumption, type PairInventoryLot, type PairLedgerJournal } from "./ledger";
import {
  applyAuthoritativeResolution,
  settleVirtualMerge,
  type PairSettlementRecord,
} from "./settlement";

export interface PairSettlementEffectIntent {
  readonly effectId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly actionId: string;
  readonly actionKind: "PAPER_VIRTUAL_MERGE";
  readonly groupId: PairGroupId;
  readonly matchedShares6: bigint;
  readonly settlementCost6: bigint;
  readonly settlementCashReserved6: bigint;
  readonly notBeforeMs: number;
  readonly deadlineMs: number;
  readonly effectOrdinal: 0;
  readonly increasesExposure: false;
}

export interface PlanPairSettlementInput {
  readonly groupId: PairGroupId;
  readonly pairAccountId: string;
  readonly groupState: string;
  readonly policy: PairSettlementPolicy;
  readonly upTokenId: string;
  readonly downTokenId: string;
  readonly lots: readonly PairInventoryLot[];
  readonly existingConsumptions: readonly PairInventoryConsumption[];
  readonly existingSettlements: readonly PairSettlementRecord[];
  readonly existingEffectIds: readonly string[];
  readonly decisionSequence: number;
  readonly decisionAtMs: number;
  readonly modeledDelayMs: number;
  readonly unknownResultTimeoutMs: number;
  readonly settlementCost6: bigint;
  readonly settlementCashReserved6: bigint;
}

export type PairSettlementPlan =
  | {
      readonly kind: "AWAITING_RESOLUTION";
      readonly groupId: PairGroupId;
      readonly reason: "HOLD_POLICY" | "MERGE_FAILED" | "MERGE_CONFIRMED_RESIDUAL";
      readonly effects: readonly [];
    }
  | {
      readonly kind: "MERGE_READY";
      readonly groupId: PairGroupId;
      readonly decisionId: string;
      readonly effects: readonly [PairSettlementEffectIntent];
      readonly planHash: string;
    }
  | {
      readonly kind: "MERGE_PENDING";
      readonly groupId: PairGroupId;
      readonly effectId: string;
      readonly effects: readonly [];
    }
  | {
      readonly kind: "MERGE_BLOCKED_UNKNOWN";
      readonly groupId: PairGroupId;
      readonly effectId: string;
      readonly effects: readonly [];
    }
  | {
      readonly kind: "ALREADY_SETTLED";
      readonly groupId: PairGroupId;
      readonly operationId: string;
      readonly effects: readonly [];
    }
  | {
      readonly kind: "REJECTED";
      readonly code: "GROUP_NOT_PAIRED" | "PAIRED_INVENTORY_MISMATCH" | "NO_PAIRED_INVENTORY";
      readonly effects: readonly [];
    };

export type VirtualMergeEvidenceStatus = "CONFIRMED" | "FAILED" | "EXPIRED" | "UNKNOWN";

export interface ApplyVirtualMergeEvidenceInput {
  readonly plan: Extract<PairSettlementPlan, { readonly kind: "MERGE_READY" }>;
  readonly pairAccountId: string;
  readonly upTokenId: string;
  readonly downTokenId: string;
  readonly lots: readonly PairInventoryLot[];
  readonly existingConsumptions: readonly PairInventoryConsumption[];
  readonly existingSettlements: readonly PairSettlementRecord[];
  readonly status: VirtualMergeEvidenceStatus;
  readonly evidenceKey: string;
  readonly occurredAtMs: number;
  readonly recordedAtMs: number;
}

export type AppliedVirtualMergeEvidence =
  | {
      readonly kind: "MERGE_CONFIRMED";
      readonly effectId: string;
      readonly matchedShares6: bigint;
      readonly cashCredit6: bigint;
      readonly consumptions: readonly PairInventoryConsumption[];
      readonly journals: readonly PairLedgerJournal[];
      readonly record: PairSettlementRecord;
      readonly reservationReleased6: bigint;
    }
  | {
      readonly kind: "AWAITING_RESOLUTION";
      readonly effectId: string;
      readonly reason: "FAILED" | "EXPIRED";
      readonly consumptions: readonly [];
      readonly journals: readonly PairLedgerJournal[];
      readonly record: PairSettlementRecord;
      readonly reservationReleased6: bigint;
    }
  | {
      readonly kind: "MERGE_BLOCKED_UNKNOWN";
      readonly effectId: string;
      readonly consumptions: readonly [];
      readonly journals: readonly [];
      readonly record: PairSettlementRecord;
      readonly reservationReleased6: 0n;
    }
  | { readonly kind: "DUPLICATE"; readonly record: PairSettlementRecord }
  | { readonly kind: "REJECTED"; readonly code: string };

export interface ApplyPairResolutionInput {
  readonly groupId: PairGroupId;
  readonly pairAccountId: string;
  readonly upTokenId: string;
  readonly downTokenId: string;
  readonly lots: readonly PairInventoryLot[];
  readonly existingConsumptions: readonly PairInventoryConsumption[];
  readonly existingSettlements: readonly PairSettlementRecord[];
  readonly resolutionId: string;
  readonly evidenceKey: string;
  readonly source: string;
  readonly sourceAuthoritative: boolean;
  readonly winner: PairOutcome;
  readonly settlementCashReserved6: bigint;
  readonly occurredAtMs: number;
  readonly recordedAtMs: number;
}

export type AppliedPairResolution =
  | {
      readonly kind: "RESOLUTION_APPLIED";
      readonly payout6: bigint;
      readonly consumptions: readonly PairInventoryConsumption[];
      readonly journals: readonly PairLedgerJournal[];
      readonly record: PairSettlementRecord;
      readonly reservationReleased6: bigint;
    }
  | { readonly kind: "DUPLICATE"; readonly record: PairSettlementRecord }
  | { readonly kind: "BLOCKED_MERGE_UNKNOWN"; readonly effectId: string }
  | { readonly kind: "ALREADY_SETTLED"; readonly operationId: string; readonly payout6: 0n }
  | { readonly kind: "REJECTED"; readonly code: string };

function assertIdentity(value: string, label: string): void {
  if (value.length === 0) throw new TypeError(`${label} must not be empty`);
}

function assertSafeTime(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative safe integer`);
}

function assertSequence(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("decisionSequence must be a non-negative safe integer");
}

function id(prefix: string, material: unknown): string {
  return `${prefix}_${canonicalObjectHash(material).slice(0, 32)}`;
}

function heldShares(input: {
  readonly groupId: PairGroupId;
  readonly upTokenId: string;
  readonly downTokenId: string;
  readonly lots: readonly PairInventoryLot[];
  readonly existingConsumptions: readonly PairInventoryConsumption[];
}): { readonly up: bigint; readonly down: bigint } {
  const holdings = inventoryHoldings(input.lots, input.existingConsumptions, input.groupId);
  return { up: holdings[input.upTokenId] ?? 0n, down: holdings[input.downTokenId] ?? 0n };
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new RangeError(`${label} exceeds safe integer range`);
  return result;
}

export function planPairSettlement(input: PlanPairSettlementInput): PairSettlementPlan {
  assertIdentity(input.groupId, "groupId");
  assertIdentity(input.pairAccountId, "pairAccountId");
  assertIdentity(input.upTokenId, "upTokenId");
  assertIdentity(input.downTokenId, "downTokenId");
  assertSequence(input.decisionSequence);
  assertSafeTime(input.decisionAtMs, "decisionAtMs");
  assertSafeTime(input.modeledDelayMs, "modeledDelayMs");
  assertSafeTime(input.unknownResultTimeoutMs, "unknownResultTimeoutMs");
  if (input.settlementCost6 < 0n || input.settlementCashReserved6 < 0n) {
    throw new RangeError("settlement amounts must be non-negative");
  }
  if (input.policy === "HOLD_TO_RESOLUTION") {
    return Object.freeze({ kind: "AWAITING_RESOLUTION", groupId: input.groupId, reason: "HOLD_POLICY", effects: [] as const });
  }

  const priorMerge = input.existingSettlements.find((record) => record.kind === "VIRTUAL_MERGE");
  if (priorMerge?.status === "CONFIRMED") {
    const remaining = heldShares(input);
    if (remaining.up + remaining.down > 0n) {
      return Object.freeze({
        kind: "AWAITING_RESOLUTION",
        groupId: input.groupId,
        reason: "MERGE_CONFIRMED_RESIDUAL",
        effects: [] as const,
      });
    }
    return Object.freeze({ kind: "ALREADY_SETTLED", groupId: input.groupId, operationId: priorMerge.operationId, effects: [] as const });
  }
  if (priorMerge?.status === "UNKNOWN") {
    return Object.freeze({ kind: "MERGE_BLOCKED_UNKNOWN", groupId: input.groupId, effectId: priorMerge.operationId, effects: [] as const });
  }
  if (priorMerge?.status === "FAILED") {
    return Object.freeze({ kind: "AWAITING_RESOLUTION", groupId: input.groupId, reason: "MERGE_FAILED", effects: [] as const });
  }
  if (input.groupState !== "PAIRED") return { kind: "REJECTED", code: "GROUP_NOT_PAIRED", effects: [] };
  const current = heldShares(input);
  if (current.up <= 0n || current.down <= 0n) return { kind: "REJECTED", code: "NO_PAIRED_INVENTORY", effects: [] };
  if (current.up !== current.down) return { kind: "REJECTED", code: "PAIRED_INVENTORY_MISMATCH", effects: [] };

  const decisionId = id("pset", {
    groupId: input.groupId,
    policy: input.policy,
    decisionSequence: input.decisionSequence,
    decisionAtMs: input.decisionAtMs,
    matchedShares6: current.up,
    settlementCost6: input.settlementCost6,
    settlementCashReserved6: input.settlementCashReserved6,
  });
  const actionId = id("pact", { groupId: input.groupId, decisionId, actionKind: "PAPER_VIRTUAL_MERGE" });
  const notBeforeMs = checkedAdd(input.decisionAtMs, input.modeledDelayMs, "merge not-before time");
  const deadlineMs = checkedAdd(notBeforeMs, input.unknownResultTimeoutMs, "merge deadline");
  const request = {
    groupId: input.groupId,
    pairAccountId: input.pairAccountId,
    decisionId,
    actionId,
    actionKind: "PAPER_VIRTUAL_MERGE",
    matchedShares6: current.up,
    settlementCost6: input.settlementCost6,
    settlementCashReserved6: input.settlementCashReserved6,
    notBeforeMs,
    deadlineMs,
    effectOrdinal: 0,
  } as const;
  const requestHash = immutableRequestHash(request);
  const idempotencyKey = effectIdempotencyKey({
    groupId: input.groupId,
    actionKind: request.actionKind,
    actionSequence: BigInt(input.decisionSequence),
    effectOrdinal: 0,
    immutableRequestHash: requestHash,
  });
  const effect = Object.freeze({
    effectId: id("peff", { idempotencyKey, requestHash }),
    idempotencyKey,
    requestHash,
    actionId,
    actionKind: request.actionKind,
    groupId: input.groupId,
    matchedShares6: current.up,
    settlementCost6: input.settlementCost6,
    settlementCashReserved6: input.settlementCashReserved6,
    notBeforeMs,
    deadlineMs,
    effectOrdinal: 0,
    increasesExposure: false,
  }) satisfies PairSettlementEffectIntent;
  if (input.existingEffectIds.includes(effect.effectId)) {
    return Object.freeze({ kind: "MERGE_PENDING", groupId: input.groupId, effectId: effect.effectId, effects: [] as const });
  }
  const material = { groupId: input.groupId, decisionId, effects: Object.freeze([effect]) as readonly [PairSettlementEffectIntent] };
  return Object.freeze({ kind: "MERGE_READY", ...material, planHash: canonicalObjectHash(material) });
}

function journalContext(input: {
  readonly pairAccountId: string;
  readonly groupId: PairGroupId;
  readonly eventId: string;
  readonly journalKind: string;
  readonly occurredAtMs: number;
  readonly recordedAtMs: number;
}): JournalContext {
  return {
    journalId: id("pjrn", { eventId: input.eventId, journalKind: input.journalKind }),
    pairAccountId: input.pairAccountId,
    groupId: input.groupId,
    causationEventId: input.eventId,
    causationKind: input.journalKind,
    occurredAtMs: input.occurredAtMs,
    recordedAtMs: input.recordedAtMs,
  };
}

export function applyVirtualMergeEvidence(input: ApplyVirtualMergeEvidenceInput): AppliedVirtualMergeEvidence {
  assertIdentity(input.evidenceKey, "evidenceKey");
  assertSafeTime(input.occurredAtMs, "occurredAtMs");
  assertSafeTime(input.recordedAtMs, "recordedAtMs");
  const effect = input.plan.effects[0];
  const prior = input.existingSettlements.find((record) => record.operationId === effect.effectId);
  if (input.status === "CONFIRMED" && prior === undefined) {
    const current = heldShares({
      groupId: effect.groupId,
      upTokenId: input.upTokenId,
      downTokenId: input.downTokenId,
      lots: input.lots,
      existingConsumptions: input.existingConsumptions,
    });
    const matched = current.up < current.down ? current.up : current.down;
    if (matched !== effect.matchedShares6) return { kind: "REJECTED", code: "MERGE_INVENTORY_DIVERGED" };
  }
  const eventId = id("pevt", { effectId: effect.effectId, evidenceKey: input.evidenceKey, status: input.status });
  const releaseContext = effect.settlementCashReserved6 === 0n ? undefined : journalContext({
    pairAccountId: input.pairAccountId,
    groupId: effect.groupId,
    eventId,
    journalKind: "VIRTUAL_MERGE_RESERVATION_RELEASE",
    occurredAtMs: input.occurredAtMs,
    recordedAtMs: input.recordedAtMs,
  });
  const core = settleVirtualMerge({
    groupId: effect.groupId,
    upTokenId: input.upTokenId,
    downTokenId: input.downTokenId,
    lots: input.lots,
    existingConsumptions: input.existingConsumptions,
    existingSettlements: input.existingSettlements,
    eventId,
    occurredAtMs: input.occurredAtMs,
    effectId: effect.effectId,
    evidenceKey: input.evidenceKey,
    result: input.status === "EXPIRED" ? "FAILED" : input.status,
    settlementCost6: effect.settlementCost6,
    settlementCashReserved6: effect.settlementCashReserved6,
    journalContext: journalContext({
      pairAccountId: input.pairAccountId,
      groupId: effect.groupId,
      eventId,
      journalKind: "VIRTUAL_MERGE",
      occurredAtMs: input.occurredAtMs,
      recordedAtMs: input.recordedAtMs,
    }),
    releaseJournalContext: releaseContext,
  });
  if (core.kind === "DUPLICATE" || core.kind === "REJECTED") return core;
  if (core.kind === "UNKNOWN") {
    return {
      kind: "MERGE_BLOCKED_UNKNOWN",
      effectId: effect.effectId,
      consumptions: [],
      journals: [],
      record: core.record,
      reservationReleased6: 0n,
    };
  }
  if (core.kind === "FAILED") {
    return {
      kind: "AWAITING_RESOLUTION",
      effectId: effect.effectId,
      reason: input.status === "EXPIRED" ? "EXPIRED" : "FAILED",
      consumptions: [],
      journals: core.journals,
      record: core.record,
      reservationReleased6: effect.settlementCashReserved6,
    };
  }
  return {
    kind: "MERGE_CONFIRMED",
    effectId: effect.effectId,
    matchedShares6: core.matchedShares6,
    cashCredit6: core.cashCredit6,
    consumptions: core.consumptions,
    journals: core.journals,
    record: core.record,
    reservationReleased6: effect.settlementCashReserved6,
  };
}

export function applyPairResolution(input: ApplyPairResolutionInput): AppliedPairResolution {
  assertIdentity(input.resolutionId, "resolutionId");
  assertIdentity(input.evidenceKey, "evidenceKey");
  assertSafeTime(input.occurredAtMs, "occurredAtMs");
  assertSafeTime(input.recordedAtMs, "recordedAtMs");
  const unknownMerge = input.existingSettlements.find((record) => record.kind === "VIRTUAL_MERGE" && record.status === "UNKNOWN");
  if (unknownMerge !== undefined) return { kind: "BLOCKED_MERGE_UNKNOWN", effectId: unknownMerge.operationId };

  const eventId = id("pevt", { resolutionId: input.resolutionId, evidenceKey: input.evidenceKey, winner: input.winner });
  const releaseContext = input.settlementCashReserved6 === 0n ? undefined : journalContext({
    pairAccountId: input.pairAccountId,
    groupId: input.groupId,
    eventId,
    journalKind: "RESOLUTION_RESERVATION_RELEASE",
    occurredAtMs: input.occurredAtMs,
    recordedAtMs: input.recordedAtMs,
  });
  const core = applyAuthoritativeResolution({
    groupId: input.groupId,
    upTokenId: input.upTokenId,
    downTokenId: input.downTokenId,
    lots: input.lots,
    existingConsumptions: input.existingConsumptions,
    existingSettlements: input.existingSettlements,
    eventId,
    occurredAtMs: input.occurredAtMs,
    resolutionId: input.resolutionId,
    evidenceKey: input.evidenceKey,
    source: input.source,
    sourceAuthoritative: input.sourceAuthoritative,
    winner: input.winner,
    settlementCashReserved6: input.settlementCashReserved6,
    journalContext: journalContext({
      pairAccountId: input.pairAccountId,
      groupId: input.groupId,
      eventId,
      journalKind: "AUTHORITATIVE_RESOLUTION",
      occurredAtMs: input.occurredAtMs,
      recordedAtMs: input.recordedAtMs,
    }),
    releaseJournalContext: releaseContext,
  });
  if (core.kind === "DUPLICATE") return core;
  if (core.kind === "REJECTED") {
    if (
      core.code === "NO_INVENTORY_TO_RESOLVE" &&
      input.existingSettlements.some((record) => record.kind === "VIRTUAL_MERGE" && record.status === "CONFIRMED")
    ) {
      const merge = input.existingSettlements.find((record) => record.kind === "VIRTUAL_MERGE" && record.status === "CONFIRMED")!;
      return { kind: "ALREADY_SETTLED", operationId: merge.operationId, payout6: 0n };
    }
    return core;
  }
  return {
    kind: "RESOLUTION_APPLIED",
    payout6: core.payout6,
    consumptions: core.consumptions,
    journals: core.journals,
    record: core.record,
    reservationReleased6: input.settlementCashReserved6,
  };
}

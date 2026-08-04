import type { PairGroupId, PairOutcome } from "./contracts";
import {
  consumeInventoryFifo,
  inventoryHoldings,
  releaseCashReservationJournal,
  resolutionJournal,
  virtualMergeJournal,
  type JournalContext,
  type PairInventoryConsumption,
  type PairInventoryLot,
  type PairLedgerJournal,
} from "./ledger";

/** Pure settlement rules. Venue/outbox persistence belongs outside this module. */
export interface PairSettlementRecord {
  readonly operationId: string;
  readonly kind: "VIRTUAL_MERGE" | "RESOLUTION";
  readonly status: "CONFIRMED" | "FAILED" | "UNKNOWN";
  readonly evidenceKey: string;
  readonly upConsumedShares6: bigint;
  readonly downConsumedShares6: bigint;
  /** Net cash-account increase after an explicit settlement cost. */
  readonly cashCredit6: bigint;
  readonly winner: PairOutcome | null;
}

interface SettlementInventoryInput {
  readonly groupId: PairGroupId;
  readonly upTokenId: string;
  readonly downTokenId: string;
  readonly lots: readonly PairInventoryLot[];
  readonly existingConsumptions: readonly PairInventoryConsumption[];
  readonly existingSettlements: readonly PairSettlementRecord[];
  readonly eventId: string;
  readonly occurredAtMs: number;
}

export interface VirtualMergeInput extends SettlementInventoryInput {
  readonly effectId: string;
  readonly evidenceKey: string;
  readonly result: "CONFIRMED" | "FAILED" | "UNKNOWN";
  readonly settlementCost6: bigint;
  readonly settlementCashReserved6: bigint;
  readonly journalContext: JournalContext;
  readonly releaseJournalContext?: JournalContext;
}

export type VirtualMergeResult =
  | { readonly kind: "CONFIRMED"; readonly matchedShares6: bigint; readonly cashCredit6: bigint; readonly consumptions: readonly PairInventoryConsumption[]; readonly journals: readonly PairLedgerJournal[]; readonly record: PairSettlementRecord; readonly upRemainingShares6: bigint; readonly downRemainingShares6: bigint }
  | { readonly kind: "FAILED"; readonly consumptions: readonly []; readonly journals: readonly PairLedgerJournal[]; readonly record: PairSettlementRecord }
  | { readonly kind: "UNKNOWN"; readonly consumptions: readonly []; readonly journals: readonly []; readonly record: PairSettlementRecord }
  | { readonly kind: "DUPLICATE"; readonly record: PairSettlementRecord }
  | { readonly kind: "REJECTED"; readonly code: "EVIDENCE_CONFLICT" | "NO_MATCHED_INVENTORY" | "SETTLEMENT_COST_EXCEEDS_RESERVATION" | "SETTLEMENT_COST_EXCEEDS_PAYOUT" };

function holdings(input: SettlementInventoryInput): { readonly up: bigint; readonly down: bigint } {
  const byToken = inventoryHoldings(input.lots, input.existingConsumptions, input.groupId);
  return { up: byToken[input.upTokenId] ?? 0n, down: byToken[input.downTokenId] ?? 0n };
}

function releaseReservation(
  reserved6: bigint,
  context: JournalContext | undefined,
): readonly PairLedgerJournal[] {
  if (reserved6 === 0n) return [];
  if (reserved6 < 0n) throw new TypeError("settlement reservation must be non-negative");
  if (context === undefined) throw new TypeError("releaseJournalContext is required for a nonzero reservation release");
  return [releaseCashReservationJournal(context, reserved6)];
}

/**
 * Apply one durable virtual-merge result. UNKNOWN never changes balances;
 * CONFIRMED consumes only the current matched minimum, so merged units cannot
 * later be paid again by resolution.
 */
export function settleVirtualMerge(input: VirtualMergeInput): VirtualMergeResult {
  if (input.settlementCost6 < 0n || input.settlementCashReserved6 < 0n) throw new TypeError("settlement amounts must be non-negative");
  const prior = input.existingSettlements.find((item) => item.operationId === input.effectId);
  if (prior !== undefined) {
    if (prior.evidenceKey === input.evidenceKey && prior.status === input.result) return { kind: "DUPLICATE", record: prior };
    return { kind: "REJECTED", code: "EVIDENCE_CONFLICT" };
  }

  if (input.result !== "CONFIRMED") {
    const record: PairSettlementRecord = Object.freeze({
      operationId: input.effectId,
      kind: "VIRTUAL_MERGE",
      status: input.result,
      evidenceKey: input.evidenceKey,
      upConsumedShares6: 0n,
      downConsumedShares6: 0n,
      cashCredit6: 0n,
      winner: null,
    });
    if (input.result === "UNKNOWN") return { kind: "UNKNOWN", consumptions: [], journals: [], record };
    return {
      kind: "FAILED",
      consumptions: [],
      journals: releaseReservation(input.settlementCashReserved6, input.releaseJournalContext),
      record,
    };
  }

  const current = holdings(input);
  const matchedShares6 = current.up < current.down ? current.up : current.down;
  if (matchedShares6 <= 0n) return { kind: "REJECTED", code: "NO_MATCHED_INVENTORY" };
  const usesReservedCost = input.settlementCashReserved6 > 0n;
  if (usesReservedCost && input.settlementCost6 > input.settlementCashReserved6) {
    return { kind: "REJECTED", code: "SETTLEMENT_COST_EXCEEDS_RESERVATION" };
  }
  if (!usesReservedCost && input.settlementCost6 > matchedShares6) {
    return { kind: "REJECTED", code: "SETTLEMENT_COST_EXCEEDS_PAYOUT" };
  }

  const up = consumeInventoryFifo({
    lots: input.lots,
    existingConsumptions: input.existingConsumptions,
    groupId: input.groupId,
    tokenId: input.upTokenId,
    shares6: matchedShares6,
    eventId: input.eventId,
    consumptionKind: "VIRTUAL_MERGE",
    createdAtMs: input.occurredAtMs,
  });
  const down = consumeInventoryFifo({
    lots: input.lots,
    existingConsumptions: input.existingConsumptions,
    groupId: input.groupId,
    tokenId: input.downTokenId,
    shares6: matchedShares6,
    eventId: input.eventId,
    consumptionKind: "VIRTUAL_MERGE",
    createdAtMs: input.occurredAtMs,
  });
  if (!up.ok || !down.ok) throw new TypeError("matched inventory changed during pure settlement calculation");

  const settlement = virtualMergeJournal({
    context: input.journalContext,
    upTokenId: input.upTokenId,
    downTokenId: input.downTokenId,
    matchedShares6,
    allocatedUpPrincipalCost6: up.allocatedPrincipalCost6,
    allocatedDownPrincipalCost6: down.allocatedPrincipalCost6,
    settlementCost6: input.settlementCost6,
    costSource: usesReservedCost ? "RESERVED" : "AVAILABLE",
  });
  const unusedReservation6 = input.settlementCashReserved6 - (usesReservedCost ? input.settlementCost6 : 0n);
  const release = releaseReservation(unusedReservation6, input.releaseJournalContext);
  const record: PairSettlementRecord = Object.freeze({
    operationId: input.effectId,
    kind: "VIRTUAL_MERGE",
    status: "CONFIRMED",
    evidenceKey: input.evidenceKey,
    upConsumedShares6: matchedShares6,
    downConsumedShares6: matchedShares6,
    cashCredit6: matchedShares6 - input.settlementCost6,
    winner: null,
  });
  return {
    kind: "CONFIRMED",
    matchedShares6,
    cashCredit6: record.cashCredit6,
    consumptions: [...up.consumptions, ...down.consumptions],
    journals: [settlement, ...release],
    record,
    upRemainingShares6: current.up - matchedShares6,
    downRemainingShares6: current.down - matchedShares6,
  };
}

export interface AuthoritativeResolutionInput extends SettlementInventoryInput {
  readonly resolutionId: string;
  readonly evidenceKey: string;
  readonly source: string;
  readonly sourceAuthoritative: boolean;
  readonly winner: PairOutcome;
  readonly settlementCashReserved6: bigint;
  readonly journalContext: JournalContext;
  readonly releaseJournalContext?: JournalContext;
}

export type AuthoritativeResolutionResult =
  | { readonly kind: "APPLIED"; readonly payout6: bigint; readonly consumptions: readonly PairInventoryConsumption[]; readonly journals: readonly PairLedgerJournal[]; readonly record: PairSettlementRecord }
  | { readonly kind: "DUPLICATE"; readonly record: PairSettlementRecord }
  | { readonly kind: "REJECTED"; readonly code: "RESOLUTION_SOURCE_NON_AUTHORITATIVE" | "EVIDENCE_CONFLICT" | "CONFLICTING_RESOLUTION" | "NO_INVENTORY_TO_RESOLVE" };

/** Settle all still-unconsumed token lots from one authoritative resolution. */
export function applyAuthoritativeResolution(input: AuthoritativeResolutionInput): AuthoritativeResolutionResult {
  if (!input.sourceAuthoritative || input.source !== "CHAINLINK") {
    return { kind: "REJECTED", code: "RESOLUTION_SOURCE_NON_AUTHORITATIVE" };
  }
  if (input.settlementCashReserved6 < 0n) throw new TypeError("settlement reservation must be non-negative");
  const priorSame = input.existingSettlements.find((item) => item.kind === "RESOLUTION" && item.operationId === input.resolutionId);
  if (priorSame !== undefined) {
    if (priorSame.evidenceKey === input.evidenceKey && priorSame.winner === input.winner) return { kind: "DUPLICATE", record: priorSame };
    return { kind: "REJECTED", code: "EVIDENCE_CONFLICT" };
  }
  if (input.existingSettlements.some((item) => item.kind === "RESOLUTION" && item.status === "CONFIRMED")) {
    return { kind: "REJECTED", code: "CONFLICTING_RESOLUTION" };
  }

  const current = holdings(input);
  if (current.up + current.down === 0n) return { kind: "REJECTED", code: "NO_INVENTORY_TO_RESOLVE" };
  const allConsumptions: PairInventoryConsumption[] = [];
  let upBasis6 = 0n;
  let downBasis6 = 0n;
  if (current.up > 0n) {
    const consumed = consumeInventoryFifo({
      lots: input.lots,
      existingConsumptions: input.existingConsumptions,
      groupId: input.groupId,
      tokenId: input.upTokenId,
      shares6: current.up,
      eventId: input.eventId,
      consumptionKind: "RESOLUTION",
      createdAtMs: input.occurredAtMs,
    });
    if (!consumed.ok) throw new TypeError("UP inventory changed during pure resolution calculation");
    allConsumptions.push(...consumed.consumptions);
    upBasis6 = consumed.allocatedPrincipalCost6;
  }
  if (current.down > 0n) {
    const consumed = consumeInventoryFifo({
      lots: input.lots,
      existingConsumptions: input.existingConsumptions,
      groupId: input.groupId,
      tokenId: input.downTokenId,
      shares6: current.down,
      eventId: input.eventId,
      consumptionKind: "RESOLUTION",
      createdAtMs: input.occurredAtMs,
    });
    if (!consumed.ok) throw new TypeError("DOWN inventory changed during pure resolution calculation");
    allConsumptions.push(...consumed.consumptions);
    downBasis6 = consumed.allocatedPrincipalCost6;
  }
  const payout6 = input.winner === "UP" ? current.up : current.down;
  const settlement = resolutionJournal({
    context: input.journalContext,
    winner: input.winner,
    upTokenId: input.upTokenId,
    downTokenId: input.downTokenId,
    upShares6: current.up,
    downShares6: current.down,
    allocatedUpPrincipalCost6: upBasis6,
    allocatedDownPrincipalCost6: downBasis6,
  });
  const record: PairSettlementRecord = Object.freeze({
    operationId: input.resolutionId,
    kind: "RESOLUTION",
    status: "CONFIRMED",
    evidenceKey: input.evidenceKey,
    upConsumedShares6: current.up,
    downConsumedShares6: current.down,
    cashCredit6: payout6,
    winner: input.winner,
  });
  return {
    kind: "APPLIED",
    payout6,
    consumptions: allConsumptions,
    journals: [settlement, ...releaseReservation(input.settlementCashReserved6, input.releaseJournalContext)],
    record,
  };
}

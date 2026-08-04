import type { PairGroupId } from "./contracts";
import {
  inventoryHoldings,
  ledgerBalanceKey,
  replayPairLedger,
  validateJournalConservation,
  type PairInventoryConsumption,
  type PairInventoryLot,
  type PairLedgerEntry,
  type PairLedgerProjection,
} from "./ledger";
import type { PairGroupAggregate } from "./states";

export type PairReconciliationSeverity = "DIAGNOSTIC" | "WARNING" | "ERROR" | "CRITICAL";
export type PairReconciliationAction = "NONE" | "REBUILD_PROJECTION" | "RETAIN_AND_OBSERVE" | "SAFE_TO_CLAIM" | "MANUAL_REVIEW";

export interface PairReconciliationDiff {
  readonly code: string;
  readonly severity: PairReconciliationSeverity;
  readonly action: PairReconciliationAction;
  readonly subjectId: string | null;
  readonly expected: string | null;
  readonly actual: string | null;
  readonly autoRepairable: boolean;
}

export interface PairStoredProjection {
  readonly state: string;
  readonly stateVersion: number;
  readonly eventCount: number;
  readonly reservedCash6: bigint;
  readonly cashDebits6: bigint;
  readonly cashCredits6: bigint;
  readonly upHeldShares6: bigint;
  readonly downHeldShares6: bigint;
  readonly matchedShares6: bigint;
  readonly residualShares6: bigint;
  readonly realizedPnl6: bigint;
}

export interface PairOrderReconciliationRecord {
  readonly orderId: string;
  readonly groupId: PairGroupId;
  readonly requestedShares6: bigint;
}

export interface PairFillReconciliationRecord {
  readonly fillId: string;
  readonly evidenceKey: string;
  readonly payloadHash: string;
  readonly groupId: PairGroupId;
  readonly orderId: string;
  readonly grossShares6: bigint;
  readonly netShares6: bigint;
}

export interface PairEffectReconciliationRecord {
  readonly effectId: string;
  readonly state: "PENDING" | "CLAIMED" | "TERMINAL" | "UNKNOWN";
  readonly claimToken: string | null;
  readonly deadlineMs: number;
  readonly resultEvidenceKey: string | null;
}

export interface PairAdapterObservation {
  readonly effectId: string;
  readonly status: "ABSENT" | "PENDING" | "FILLED" | "NO_FILL" | "REJECTED" | "UNKNOWN";
  readonly evidenceKey: string | null;
  readonly payloadHash: string | null;
}

export interface ComparePairReconciliationInput {
  readonly groupId: PairGroupId;
  readonly upTokenId: string;
  readonly downTokenId: string;
  readonly eventDerived: PairGroupAggregate;
  /** Persisted sequence numbers, in storage order. */
  readonly eventSequenceNumbers: readonly number[];
  readonly projection: PairStoredProjection;
  readonly ledgerEntries: readonly PairLedgerEntry[];
  readonly lots: readonly PairInventoryLot[];
  readonly consumptions: readonly PairInventoryConsumption[];
  readonly orders: readonly PairOrderReconciliationRecord[];
  readonly fills: readonly PairFillReconciliationRecord[];
  readonly effects: readonly PairEffectReconciliationRecord[];
  readonly adapterObservations: readonly PairAdapterObservation[];
  readonly nowMs: number;
}

export interface PairReconciliationResult {
  readonly status: "HEALTHY" | "REPAIRABLE" | "PENDING_OBSERVATION" | "MANUAL_REVIEW";
  readonly healthy: boolean;
  readonly schedulingAllowed: boolean;
  readonly projectionRebuildRequired: boolean;
  readonly retainReservation: boolean;
  readonly diffs: readonly PairReconciliationDiff[];
  readonly ledgerProjection: PairLedgerProjection | null;
}

const stringValue = (value: string | number | bigint | null): string | null => value === null ? null : String(value);

function makeDiff(
  code: string,
  severity: PairReconciliationSeverity,
  action: PairReconciliationAction,
  expected: string | number | bigint | null,
  actual: string | number | bigint | null,
  subjectId: string | null = null,
): PairReconciliationDiff {
  return {
    code,
    severity,
    action,
    subjectId,
    expected: stringValue(expected),
    actual: stringValue(actual),
    autoRepairable: action === "REBUILD_PROJECTION",
  };
}

function compareProjection(
  expected: PairGroupAggregate,
  actual: PairStoredProjection,
  realizedPnl6: bigint | null,
  diffs: PairReconciliationDiff[],
): void {
  const fields: readonly [string, string | number | bigint, string | number | bigint][] = [
    ["STATE", expected.state, actual.state],
    ["STATE_VERSION", expected.stateVersion, actual.stateVersion],
    ["EVENT_COUNT", expected.eventCount, actual.eventCount],
    ["RESERVED_CASH", expected.reservedCash6, actual.reservedCash6],
    ["CASH_DEBITS", expected.cashDebits6, actual.cashDebits6],
    ["CASH_CREDITS", expected.cashCredits6, actual.cashCredits6],
    ["UP_HOLDINGS", expected.upHeldShares6, actual.upHeldShares6],
    ["DOWN_HOLDINGS", expected.downHeldShares6, actual.downHeldShares6],
    ["MATCHED", expected.matchedShares6, actual.matchedShares6],
    ["RESIDUAL", expected.residualShares6, actual.residualShares6],
  ];
  for (const [name, expectedValue, actualValue] of fields) {
    if (expectedValue !== actualValue) {
      diffs.push(makeDiff(`PROJECTION_${name}_MISMATCH`, "ERROR", "REBUILD_PROJECTION", expectedValue, actualValue));
    }
  }
  if (realizedPnl6 !== null && realizedPnl6 !== actual.realizedPnl6) {
    diffs.push(makeDiff("PROJECTION_REALIZED_PNL_MISMATCH", "ERROR", "REBUILD_PROJECTION", realizedPnl6, actual.realizedPnl6));
  }
}

function checkEventSequence(input: ComparePairReconciliationInput, diffs: PairReconciliationDiff[]): void {
  for (let index = 0; index < input.eventSequenceNumbers.length; index += 1) {
    const expected = index + 1;
    const actual = input.eventSequenceNumbers[index];
    if (actual !== expected) {
      diffs.push(makeDiff("EVENT_SEQUENCE_GAP", "CRITICAL", "MANUAL_REVIEW", expected, actual ?? null));
      return;
    }
  }
  if (input.eventSequenceNumbers.length !== input.eventDerived.eventCount) {
    diffs.push(makeDiff("EVENT_COUNT_SOURCE_MISMATCH", "CRITICAL", "MANUAL_REVIEW", input.eventDerived.eventCount, input.eventSequenceNumbers.length));
  }
}

function checkFills(input: ComparePairReconciliationInput, diffs: PairReconciliationDiff[]): void {
  const orders = new Map(input.orders.map((order) => [order.orderId, order]));
  const fillsByEvidence = new Map<string, PairFillReconciliationRecord>();
  const journalPathsByFill = new Map<string, Set<string>>();
  for (const entry of input.ledgerEntries) {
    if (entry.fillId === null) continue;
    const paths = journalPathsByFill.get(entry.fillId) ?? new Set<string>();
    paths.add(entry.journalId);
    journalPathsByFill.set(entry.fillId, paths);
    if (entry.groupId !== input.groupId) {
      diffs.push(makeDiff("LEDGER_REFERENCES_WRONG_GROUP", "CRITICAL", "MANUAL_REVIEW", input.groupId, entry.groupId, entry.entryId));
    }
    if (entry.orderId !== null) {
      const order = orders.get(entry.orderId);
      if (order === undefined || order.groupId !== input.groupId) {
        diffs.push(makeDiff("LEDGER_REFERENCES_WRONG_ORDER", "CRITICAL", "MANUAL_REVIEW", "linked group order", entry.orderId, entry.entryId));
      }
    }
  }
  for (const fill of input.fills) {
    const previous = fillsByEvidence.get(fill.evidenceKey);
    if (previous !== undefined) {
      if (previous.payloadHash === fill.payloadHash) {
        diffs.push(makeDiff("DUPLICATE_FILL_SAME_PAYLOAD", "DIAGNOSTIC", "NONE", previous.fillId, fill.fillId, fill.evidenceKey));
      } else {
        diffs.push(makeDiff("DUPLICATE_FILL_DIFFERENT_PAYLOAD", "CRITICAL", "MANUAL_REVIEW", previous.payloadHash, fill.payloadHash, fill.evidenceKey));
      }
    } else {
      fillsByEvidence.set(fill.evidenceKey, fill);
    }
    if (fill.groupId !== input.groupId) {
      diffs.push(makeDiff("FILL_REFERENCES_WRONG_GROUP", "CRITICAL", "MANUAL_REVIEW", input.groupId, fill.groupId, fill.fillId));
    }
    const order = orders.get(fill.orderId);
    if (order === undefined || order.groupId !== input.groupId) {
      diffs.push(makeDiff("FILL_REFERENCES_WRONG_ORDER", "CRITICAL", "MANUAL_REVIEW", "linked group order", fill.orderId, fill.fillId));
    } else if (fill.grossShares6 > order.requestedShares6 || fill.grossShares6 < 0n || fill.netShares6 < 0n || fill.netShares6 > fill.grossShares6) {
      diffs.push(makeDiff("FILL_QUANTITY_INVALID", "CRITICAL", "MANUAL_REVIEW", `0..${order.requestedShares6}`, fill.grossShares6, fill.fillId));
    }
    const paths = journalPathsByFill.get(fill.fillId);
    if (paths === undefined || paths.size === 0) {
      diffs.push(makeDiff("FILL_MISSING_LEDGER_CAUSATION", "CRITICAL", "MANUAL_REVIEW", "1", "0", fill.fillId));
    } else if (paths.size !== 1) {
      diffs.push(makeDiff("FILL_DUPLICATE_LEDGER_CAUSATION", "CRITICAL", "MANUAL_REVIEW", "1", paths.size, fill.fillId));
    }
  }
}

function checkEffects(input: ComparePairReconciliationInput, diffs: PairReconciliationDiff[]): void {
  const observations = new Map(input.adapterObservations.map((item) => [item.effectId, item]));
  for (const effect of input.effects) {
    const observation = observations.get(effect.effectId);
    if (effect.state === "PENDING" && effect.claimToken === null && observation?.status !== "FILLED") {
      diffs.push(makeDiff("PENDING_EFFECT_SAFE_TO_CLAIM", "DIAGNOSTIC", "SAFE_TO_CLAIM", "unclaimed", observation?.status ?? "ABSENT", effect.effectId));
      continue;
    }
    if (effect.state === "CLAIMED" || effect.state === "UNKNOWN") {
      if (observation === undefined || observation.status === "ABSENT" || observation.status === "PENDING" || observation.status === "UNKNOWN") {
        diffs.push(makeDiff(
          input.nowMs > effect.deadlineMs ? "UNKNOWN_EFFECT_PAST_DEADLINE" : "UNKNOWN_EFFECT_REQUIRES_OBSERVATION",
          input.nowMs > effect.deadlineMs ? "CRITICAL" : "WARNING",
          input.nowMs > effect.deadlineMs ? "MANUAL_REVIEW" : "RETAIN_AND_OBSERVE",
          "terminal adapter evidence",
          observation?.status ?? "ABSENT",
          effect.effectId,
        ));
        continue;
      }
    }
    if (effect.resultEvidenceKey !== null && observation?.evidenceKey !== null && observation?.evidenceKey !== undefined
      && effect.resultEvidenceKey !== observation.evidenceKey) {
      diffs.push(makeDiff("ADAPTER_EVIDENCE_DIVERGENCE", "CRITICAL", "MANUAL_REVIEW", effect.resultEvidenceKey, observation.evidenceKey, effect.effectId));
    }
    if (effect.state === "TERMINAL" && (observation?.status === "ABSENT" || observation?.status === "PENDING" || observation?.status === "UNKNOWN")) {
      diffs.push(makeDiff("ADAPTER_TERMINAL_STATE_DIVERGENCE", "CRITICAL", "MANUAL_REVIEW", "terminal", observation.status, effect.effectId));
    }
  }
}

/**
 * Compare independently reconstructed sources without mutating any of them.
 * Projection-only differences are explicitly repairable; source/economic
 * discrepancies fail closed into manual review.
 */
export function comparePairReconciliation(input: ComparePairReconciliationInput): PairReconciliationResult {
  const diffs: PairReconciliationDiff[] = [];
  checkEventSequence(input, diffs);

  const groupEntries = input.ledgerEntries.filter((entry) => entry.groupId === input.groupId);
  let ledgerProjection: PairLedgerProjection | null = null;
  const conservation = validateJournalConservation(groupEntries);
  for (const violation of conservation) {
    diffs.push(makeDiff("UNBALANCED_LEDGER_JOURNAL", "CRITICAL", "MANUAL_REVIEW", "0", violation.imbalance6, `${violation.journalId}/${violation.assetId}`));
  }
  if (conservation.length === 0) ledgerProjection = replayPairLedger(groupEntries);

  let lotHoldings: Readonly<Record<string, bigint>> | null = null;
  try {
    lotHoldings = inventoryHoldings(input.lots, input.consumptions, input.groupId);
  } catch (error) {
    diffs.push(makeDiff("NEGATIVE_RECONSTRUCTED_INVENTORY", "CRITICAL", "MANUAL_REVIEW", "non-negative", error instanceof Error ? error.message : "invalid inventory"));
  }

  const expectedUp = input.eventDerived.upHeldShares6;
  const expectedDown = input.eventDerived.downHeldShares6;
  if (ledgerProjection !== null) {
    const ledgerUp = ledgerProjection.tokenInventoryByAsset[input.upTokenId] ?? 0n;
    const ledgerDown = ledgerProjection.tokenInventoryByAsset[input.downTokenId] ?? 0n;
    // Group-attributed available-cash lines are intentionally net-negative
    // after reservation: account funding has a nullable group id. Only the
    // group-owned reserved/token balances can be judged without mixing groups.
    if (ledgerUp < 0n || ledgerDown < 0n || ledgerProjection.cashReserved6 < 0n) {
      diffs.push(makeDiff("NEGATIVE_LEDGER_BALANCE", "CRITICAL", "MANUAL_REVIEW", "non-negative", `${ledgerProjection.cashReserved6}/${ledgerUp}/${ledgerDown}`));
    }
    if (ledgerUp !== expectedUp) diffs.push(makeDiff("EVENT_LEDGER_UP_HOLDINGS_MISMATCH", "CRITICAL", "MANUAL_REVIEW", expectedUp, ledgerUp));
    if (ledgerDown !== expectedDown) diffs.push(makeDiff("EVENT_LEDGER_DOWN_HOLDINGS_MISMATCH", "CRITICAL", "MANUAL_REVIEW", expectedDown, ledgerDown));
    // Reservation journals are group-attributed; their balance must equal the event replay.
    const ledgerReserved6 = ledgerProjection.balances[ledgerBalanceKey("USDC", "ASSET_CASH_RESERVED")] ?? 0n;
    if (ledgerReserved6 !== input.eventDerived.reservedCash6) {
      diffs.push(makeDiff("EVENT_LEDGER_RESERVATION_MISMATCH", "CRITICAL", "MANUAL_REVIEW", input.eventDerived.reservedCash6, ledgerReserved6));
    }
  }
  if (lotHoldings !== null) {
    const lotsUp = lotHoldings[input.upTokenId] ?? 0n;
    const lotsDown = lotHoldings[input.downTokenId] ?? 0n;
    if (lotsUp !== expectedUp) diffs.push(makeDiff("LOT_UP_HOLDINGS_MISMATCH", "CRITICAL", "MANUAL_REVIEW", expectedUp, lotsUp));
    if (lotsDown !== expectedDown) diffs.push(makeDiff("LOT_DOWN_HOLDINGS_MISMATCH", "CRITICAL", "MANUAL_REVIEW", expectedDown, lotsDown));
  }

  compareProjection(input.eventDerived, input.projection, ledgerProjection?.terminalRealizedPnl6 ?? null, diffs);
  checkFills(input, diffs);
  checkEffects(input, diffs);

  if ((input.eventDerived.state === "RECONCILED_FLAT" || input.eventDerived.state === "RECONCILED_SETTLED")
      && input.eventDerived.reservedCash6 !== 0n) {
    diffs.push(makeDiff("CLOSED_GROUP_RESERVATION_NONZERO", "CRITICAL", "MANUAL_REVIEW", 0n, input.eventDerived.reservedCash6));
  }

  diffs.sort((a, b) => a.code.localeCompare(b.code) || (a.subjectId ?? "").localeCompare(b.subjectId ?? ""));
  const manual = diffs.some(({ action }) => action === "MANUAL_REVIEW");
  const pending = !manual && diffs.some(({ action }) => action === "RETAIN_AND_OBSERVE");
  const repair = !manual && !pending && diffs.some(({ action }) => action === "REBUILD_PROJECTION");
  const status = manual ? "MANUAL_REVIEW" : pending ? "PENDING_OBSERVATION" : repair ? "REPAIRABLE" : "HEALTHY";
  return {
    status,
    healthy: status === "HEALTHY",
    schedulingAllowed: status === "HEALTHY",
    projectionRebuildRequired: repair,
    retainReservation: diffs.some(({ action }) => action === "RETAIN_AND_OBSERVE" || action === "MANUAL_REVIEW"),
    diffs,
    ledgerProjection,
  };
}

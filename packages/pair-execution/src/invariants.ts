import { deriveInventory, isTerminalPairGroupState, type PairGroupAggregate, type PairLegProjection } from "./states";

export const PAIR_INVARIANT_CODES = [
  "GROUP_ID_EMPTY",
  "LEG_IDS_NOT_DISTINCT",
  "LEG_EFFECT_IDS_NOT_DISTINCT",
  "LEG_EVIDENCE_KEYS_NOT_DISTINCT",
  "LEG_OUTCOME_MISMATCH",
  "VERSION_INVALID",
  "EVENT_COUNT_INVALID",
  "PROJECTION_VERSION_MISMATCH",
  "TARGET_QUANTITY_INVALID",
  "APPROVED_CAP_NEGATIVE",
  "RESERVATION_NEGATIVE",
  "RESERVATION_CAP_EXCEEDED",
  "CASH_TOTAL_NEGATIVE",
  "INVENTORY_NEGATIVE",
  "WORST_LOSS_NEGATIVE",
  "PEAK_WORST_LOSS_BELOW_CURRENT",
  "RECOVERY_ATTEMPTS_INVALID",
  "TIMESTAMP_INVALID",
  "NEXT_ACTION_LIFECYCLE_INVALID",
  "LEG_QUANTITY_NEGATIVE",
  "LEG_FILL_EXCEEDS_REQUEST",
  "INITIAL_FOK_NOT_ALL_OR_ZERO",
  "NET_FILL_EXCEEDS_GROSS",
  "LEG_CASH_DEBIT_NEGATIVE",
  "LEG_EFFECT_LIFECYCLE_INVALID",
  "LEG_RESULT_LIFECYCLE_INVALID",
  "LEG_FILL_LIFECYCLE_INVALID",
  "INITIAL_DEBITS_EXCEED_AGGREGATE",
  "CASH_CAP_EXCEEDED",
  "WORST_LOSS_CAP_EXCEEDED",
  "MATCHED_PROJECTION_MISMATCH",
  "RESIDUAL_PROJECTION_MISMATCH",
  "NO_FILL_STATE_HAS_EXPOSURE",
  "CLASSIFICATION_BEFORE_LEGS_TERMINAL",
  "PAIRED_STATE_NOT_PAIRED",
  "RESIDUAL_STATE_NOT_RESIDUAL",
  "SETTLEMENT_STATE_NOT_PAIRED",
  "FLAT_TERMINAL_HAS_EXPOSURE",
  "SETTLED_TERMINAL_NOT_SETTLED",
  "TERMINAL_RESERVATION_NONZERO",
  "CLOSED_STATE_NOT_TERMINAL",
  "TERMINAL_STATE_NOT_HEALTHY",
  "HALT_FIELDS_INCONSISTENT",
  "SAFETY_BREACH_NOT_HALTED",
] as const;

export type PairInvariantCode = (typeof PAIR_INVARIANT_CODES)[number];

export interface PairInvariantViolation {
  readonly code: PairInvariantCode;
  readonly detail: string;
}

export class PairInvariantError extends Error {
  constructor(readonly violations: readonly PairInvariantViolation[]) {
    super(violations.map(({ code, detail }) => `${code}: ${detail}`).join("; "));
    this.name = "PairInvariantError";
  }
}

const ZERO_FILL_STATES = new Set(["NO_FILL", "REJECTED", "CANCELED", "SKIPPED"]);
const EFFECT_STATES = new Set(["EFFECT_PENDING", "DISPATCH_CLAIMED", "DISPATCHED", "FILLED", "NO_FILL", "REJECTED", "CANCELED", "UNKNOWN"]);
const RESULT_STATES = new Set(["FILLED", "NO_FILL", "REJECTED", "UNKNOWN"]);

function checkLeg(leg: PairLegProjection, violations: PairInvariantViolation[]): void {
  const add = (code: PairInvariantCode, detail: string): void => { violations.push({ code, detail: `${leg.outcome}: ${detail}` }); };
  if (leg.requestedGrossShares6 < 0n || leg.filledGrossShares6 < 0n || leg.receivedNetShares6 < 0n) {
    add("LEG_QUANTITY_NEGATIVE", "leg quantities must be non-negative");
  }
  if (leg.filledGrossShares6 > leg.requestedGrossShares6) add("LEG_FILL_EXCEEDS_REQUEST", "gross fill exceeds requested quantity");
  if (leg.receivedNetShares6 > leg.filledGrossShares6) add("NET_FILL_EXCEEDS_GROSS", "net received exceeds gross fill");
  if (leg.cashDebit6 < 0n) add("LEG_CASH_DEBIT_NEGATIVE", "cash debit must be non-negative");

  if (leg.state === "FILLED" && (leg.requestedGrossShares6 <= 0n || leg.filledGrossShares6 !== leg.requestedGrossShares6)) {
    add("INITIAL_FOK_NOT_ALL_OR_ZERO", "an initial FILLED result must equal the full positive requested quantity");
  }
  if (ZERO_FILL_STATES.has(leg.state) && leg.filledGrossShares6 !== 0n) {
    add("INITIAL_FOK_NOT_ALL_OR_ZERO", `${leg.state} must have zero gross fill`);
  }
  if (leg.effectId === null && EFFECT_STATES.has(leg.state)) add("LEG_EFFECT_LIFECYCLE_INVALID", `${leg.state} requires an effect id`);
  if (leg.actualDispatchAtMs !== null && leg.state === "PLANNED") add("LEG_EFFECT_LIFECYCLE_INVALID", "a planned leg cannot have a dispatch timestamp");
  if (leg.resultEvidenceKey === null && RESULT_STATES.has(leg.state)) add("LEG_RESULT_LIFECYCLE_INVALID", `${leg.state} requires result evidence`);
  if (leg.fillEvidenceKey !== null && leg.state !== "FILLED") add("LEG_FILL_LIFECYCLE_INVALID", "fill evidence is valid only for FILLED");
  if (leg.fillEvidenceKey !== null && leg.receivedNetShares6 <= 0n) add("LEG_FILL_LIFECYCLE_INVALID", "fill evidence requires positive net inventory");
}

/**
 * Validate the aggregate projection without mutating it. Ledger/lot-specific
 * conservation is intentionally checked by the ledger module; these checks
 * cover the lifecycle projection owned by the reducer.
 */
export function validatePairGroupInvariants(aggregate: PairGroupAggregate): readonly PairInvariantViolation[] {
  const violations: PairInvariantViolation[] = [];
  const add = (code: PairInvariantCode, detail: string): void => { violations.push({ code, detail }); };

  if (aggregate.groupId.length === 0) add("GROUP_ID_EMPTY", "group id must be non-empty");
  if (aggregate.upLeg.legId === aggregate.downLeg.legId) add("LEG_IDS_NOT_DISTINCT", "UP and DOWN legs must have distinct ids");
  if (aggregate.upLeg.effectId !== null && aggregate.upLeg.effectId === aggregate.downLeg.effectId) add("LEG_EFFECT_IDS_NOT_DISTINCT", "UP and DOWN legs must not share an effect id");
  for (const [upKey, downKey] of [
    [aggregate.upLeg.resultEvidenceKey, aggregate.downLeg.resultEvidenceKey],
    [aggregate.upLeg.fillEvidenceKey, aggregate.downLeg.fillEvidenceKey],
  ] as const) {
    if (upKey !== null && upKey === downKey) add("LEG_EVIDENCE_KEYS_NOT_DISTINCT", "UP and DOWN legs must not share result/fill evidence keys");
  }
  if (aggregate.upLeg.outcome !== "UP" || aggregate.downLeg.outcome !== "DOWN") add("LEG_OUTCOME_MISMATCH", "leg outcomes must match their projection slots");
  if (!Number.isSafeInteger(aggregate.stateVersion) || aggregate.stateVersion < 1) add("VERSION_INVALID", "state version must be a positive safe integer");
  if (!Number.isSafeInteger(aggregate.eventCount) || aggregate.eventCount < 1) add("EVENT_COUNT_INVALID", "event count must be a positive safe integer");
  if (aggregate.stateVersion !== aggregate.eventCount || Object.keys(aggregate.appliedEventIds).length !== aggregate.eventCount) {
    add("PROJECTION_VERSION_MISMATCH", "state version, event count, and applied event ids must agree");
  }
  if (aggregate.targetGrossShares6 <= 0n) add("TARGET_QUANTITY_INVALID", "target quantity must be positive");
  if (aggregate.approvedCashCap6 < 0n || aggregate.approvedResidualLoss6 < 0n) add("APPROVED_CAP_NEGATIVE", "approved caps must be non-negative");
  if (aggregate.reservedCash6 < 0n) add("RESERVATION_NEGATIVE", "reservation must be non-negative");
  if (aggregate.reservedCash6 > aggregate.approvedCashCap6) add("RESERVATION_CAP_EXCEEDED", "reservation exceeds the approved aggregate cash cap");
  if (aggregate.cashDebits6 < 0n || aggregate.cashCredits6 < 0n) add("CASH_TOTAL_NEGATIVE", "cash totals must be non-negative");
  if (aggregate.upHeldShares6 < 0n || aggregate.downHeldShares6 < 0n) add("INVENTORY_NEGATIVE", "held quantities must be non-negative");
  if (aggregate.currentWorstCaseLoss6 < 0n || aggregate.peakWorstCaseLoss6 < 0n) add("WORST_LOSS_NEGATIVE", "worst-loss projections must be non-negative");
  if (aggregate.peakWorstCaseLoss6 < aggregate.currentWorstCaseLoss6) add("PEAK_WORST_LOSS_BELOW_CURRENT", "peak worst loss cannot be below current worst loss");
  if (!Number.isSafeInteger(aggregate.recoveryAttempts) || aggregate.recoveryAttempts < 0 || aggregate.recoveryAttempts > 1) add("RECOVERY_ATTEMPTS_INVALID", "v0 permits at most one recovery attempt");
  const timestamps = [aggregate.nextActionAtMs, aggregate.haltedAtMs, aggregate.closedAtMs, aggregate.upLeg.actualDispatchAtMs, aggregate.downLeg.actualDispatchAtMs];
  if (timestamps.some((value) => value !== null && (!Number.isSafeInteger(value) || value < 0))) add("TIMESTAMP_INVALID", "projection timestamps must be non-negative safe integers");
  if (aggregate.nextActionAtMs !== null && (aggregate.state !== "SUBMITTING" || aggregate.dispatchModel === "PARALLEL")) {
    add("NEXT_ACTION_LIFECYCLE_INVALID", "a complement timer is valid only while a serial group is SUBMITTING");
  }

  checkLeg(aggregate.upLeg, violations);
  checkLeg(aggregate.downLeg, violations);
  if (aggregate.upLeg.cashDebit6 + aggregate.downLeg.cashDebit6 > aggregate.cashDebits6) {
    add("INITIAL_DEBITS_EXCEED_AGGREGATE", "aggregate cash debits omit one or more initial leg debits");
  }
  if (aggregate.cashDebits6 > aggregate.approvedCashCap6) add("CASH_CAP_EXCEEDED", "cash debits exceed the approved aggregate cap");
  if (aggregate.currentWorstCaseLoss6 > aggregate.approvedResidualLoss6 || aggregate.peakWorstCaseLoss6 > aggregate.approvedResidualLoss6) {
    add("WORST_LOSS_CAP_EXCEEDED", "current or peak worst loss exceeds the approved residual-loss cap");
  }

  const derived = deriveInventory(aggregate.upHeldShares6, aggregate.downHeldShares6);
  if (aggregate.matchedShares6 !== derived.matchedShares6) add("MATCHED_PROJECTION_MISMATCH", "matched quantity is not min(UP, DOWN)");
  if (aggregate.residualSide !== derived.residualSide || aggregate.residualShares6 !== derived.residualShares6) {
    add("RESIDUAL_PROJECTION_MISMATCH", "residual side/quantity does not match held inventory");
  }

  if (aggregate.state === "NO_INITIAL_FILL" && (aggregate.upHeldShares6 !== 0n || aggregate.downHeldShares6 !== 0n)) add("NO_FILL_STATE_HAS_EXPOSURE", "NO_INITIAL_FILL cannot hold inventory");
  if ((aggregate.state === "NO_INITIAL_FILL" || aggregate.state === "PAIRED" || aggregate.state === "RESIDUAL")
      && (!new Set(["FILLED", "NO_FILL", "REJECTED", "CANCELED", "SKIPPED"]).has(aggregate.upLeg.state)
        || !new Set(["FILLED", "NO_FILL", "REJECTED", "CANCELED", "SKIPPED"]).has(aggregate.downLeg.state))) {
    add("CLASSIFICATION_BEFORE_LEGS_TERMINAL", `${aggregate.state} requires both intended initial legs to be terminal`);
  }
  if (aggregate.state === "PAIRED" && (aggregate.upHeldShares6 <= 0n || aggregate.upHeldShares6 !== aggregate.downHeldShares6)) add("PAIRED_STATE_NOT_PAIRED", "PAIRED requires equal positive holdings");
  if (aggregate.state === "RESIDUAL" && aggregate.upHeldShares6 === aggregate.downHeldShares6) add("RESIDUAL_STATE_NOT_RESIDUAL", "RESIDUAL requires unequal holdings");
  if ((aggregate.state === "AWAITING_SETTLEMENT" || aggregate.state === "MERGE_PENDING" || aggregate.state === "MERGE_OUTCOME_UNKNOWN")
      && (aggregate.upHeldShares6 <= 0n || aggregate.upHeldShares6 !== aggregate.downHeldShares6)) {
    add("SETTLEMENT_STATE_NOT_PAIRED", `${aggregate.state} requires equal positive holdings`);
  }
  if (isTerminalPairGroupState(aggregate.state)) {
    if (aggregate.upHeldShares6 !== 0n || aggregate.downHeldShares6 !== 0n) add("FLAT_TERMINAL_HAS_EXPOSURE", "terminal groups must have zero holdings");
    if (aggregate.reservedCash6 !== 0n) add("TERMINAL_RESERVATION_NONZERO", "terminal groups must have zero reservation");
    if (aggregate.reconciliationStatus !== "HEALTHY") add("TERMINAL_STATE_NOT_HEALTHY", "terminal groups require healthy reconciliation");
  }
  if (aggregate.state === "RECONCILED_SETTLED" && !aggregate.settled) add("SETTLED_TERMINAL_NOT_SETTLED", "RECONCILED_SETTLED requires settlement evidence");
  if (aggregate.closedAtMs !== null && !isTerminalPairGroupState(aggregate.state)) add("CLOSED_STATE_NOT_TERMINAL", "only terminal groups may be closed");
  if ((aggregate.haltedAtMs === null) !== (aggregate.haltReason === null)) add("HALT_FIELDS_INCONSISTENT", "halt timestamp and reason must both be present or absent");
  if (aggregate.safetyBreachRecorded && (aggregate.state !== "MANUAL_REVIEW" || aggregate.haltedAtMs === null)) add("SAFETY_BREACH_NOT_HALTED", "a recorded safety breach must halt in MANUAL_REVIEW");

  return violations;
}

export function assertPairGroupInvariants(aggregate: PairGroupAggregate): void {
  const violations = validatePairGroupInvariants(aggregate);
  if (violations.length > 0) throw new PairInvariantError(violations);
}

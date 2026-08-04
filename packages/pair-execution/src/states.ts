import type { PairDispatchModel, PairGroupId, PairLegId, PairOutcome } from "./contracts";

export const PAIR_GROUP_STATES = [
  "SCHEDULED",
  "ACTIVATING",
  "ACTIVATION_REJECTED",
  "SUBMITTING",
  "OUTCOME_UNKNOWN",
  "NO_INITIAL_FILL",
  "PAIRED",
  "RESIDUAL",
  "RECOVERY_PENDING",
  "RECOVERING",
  "RECOVERY_OUTCOME_UNKNOWN",
  "AWAITING_SETTLEMENT",
  "MERGE_PENDING",
  "MERGE_OUTCOME_UNKNOWN",
  "AWAITING_RESOLUTION",
  "RECONCILING",
  "RECONCILED_FLAT",
  "RECONCILED_SETTLED",
  "MANUAL_REVIEW",
] as const;

export type PairGroupState = (typeof PAIR_GROUP_STATES)[number];

export const PAIR_LEG_STATES = [
  "PLANNED",
  "EFFECT_PENDING",
  "DISPATCH_CLAIMED",
  "DISPATCHED",
  "FILLED",
  "NO_FILL",
  "REJECTED",
  "CANCELED",
  "SKIPPED",
  "PARTIAL_CANCELED",
  "UNKNOWN",
] as const;

export type PairLegState = (typeof PAIR_LEG_STATES)[number];

export const INITIAL_LEG_TERMINAL_STATES = [
  "FILLED",
  "NO_FILL",
  "REJECTED",
  "CANCELED",
  "SKIPPED",
] as const satisfies readonly PairLegState[];

export type InitialLegTerminalState = (typeof INITIAL_LEG_TERMINAL_STATES)[number];
export type PairResidualSide = PairOutcome | null;

export interface PairLegProjection {
  readonly legId: PairLegId;
  readonly outcome: PairOutcome;
  readonly state: PairLegState;
  readonly requestedGrossShares6: bigint;
  readonly filledGrossShares6: bigint;
  readonly receivedNetShares6: bigint;
  readonly cashDebit6: bigint;
  readonly effectId: string | null;
  readonly resultEvidenceKey: string | null;
  readonly fillEvidenceKey: string | null;
  readonly actualDispatchAtMs: number | null;
}

export interface PairGroupAggregate {
  readonly groupId: PairGroupId;
  readonly state: PairGroupState;
  readonly stateVersion: number;
  readonly eventCount: number;
  readonly dispatchModel: PairDispatchModel;
  readonly upLeg: PairLegProjection;
  readonly downLeg: PairLegProjection;
  readonly targetGrossShares6: bigint;
  readonly approvedCashCap6: bigint;
  readonly approvedResidualLoss6: bigint;
  readonly reservedCash6: bigint;
  readonly cashDebits6: bigint;
  readonly cashCredits6: bigint;
  readonly upHeldShares6: bigint;
  readonly downHeldShares6: bigint;
  readonly matchedShares6: bigint;
  readonly residualSide: PairResidualSide;
  readonly residualShares6: bigint;
  readonly currentWorstCaseLoss6: bigint;
  readonly peakWorstCaseLoss6: bigint;
  readonly nextActionAtMs: number | null;
  readonly recoveryAttempts: number;
  readonly haltedAtMs: number | null;
  readonly haltReason: string | null;
  readonly reconciliationStatus: "NOT_STARTED" | "PENDING" | "HEALTHY" | "MISMATCH";
  readonly closedAtMs: number | null;
  readonly settled: boolean;
  readonly safetyBreachRecorded: boolean;
  /** Structured projection/invariant breaches retained for reconciliation. */
  readonly invariantBreachCodes: readonly string[];
  /** Internal replay keys. These are persistence metadata, never economic truth. */
  readonly appliedEventIds: Readonly<Record<string, string>>;
  readonly appliedDedupeKeys: Readonly<Record<string, string>>;
}

export function isPairGroupState(value: string): value is PairGroupState {
  return (PAIR_GROUP_STATES as readonly string[]).includes(value);
}

export function isInitialLegTerminal(state: PairLegState): state is InitialLegTerminalState {
  return (INITIAL_LEG_TERMINAL_STATES as readonly string[]).includes(state);
}

export function deriveInventory(upHeldShares6: bigint, downHeldShares6: bigint): {
  readonly matchedShares6: bigint;
  readonly residualSide: PairResidualSide;
  readonly residualShares6: bigint;
} {
  const matchedShares6 = upHeldShares6 < downHeldShares6 ? upHeldShares6 : downHeldShares6;
  if (upHeldShares6 > downHeldShares6) {
    return { matchedShares6, residualSide: "UP", residualShares6: upHeldShares6 - downHeldShares6 };
  }
  if (downHeldShares6 > upHeldShares6) {
    return { matchedShares6, residualSide: "DOWN", residualShares6: downHeldShares6 - upHeldShares6 };
  }
  return { matchedShares6, residualSide: null, residualShares6: 0n };
}

export function pairLeg(aggregate: PairGroupAggregate, outcome: PairOutcome): PairLegProjection {
  return outcome === "UP" ? aggregate.upLeg : aggregate.downLeg;
}

export function bothInitialLegsTerminal(aggregate: PairGroupAggregate): boolean {
  return isInitialLegTerminal(aggregate.upLeg.state) && isInitialLegTerminal(aggregate.downLeg.state);
}

export function isTerminalPairGroupState(state: PairGroupState): boolean {
  return state === "RECONCILED_FLAT" || state === "RECONCILED_SETTLED";
}

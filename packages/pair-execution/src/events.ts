import type { PairDispatchModel, PairEventId, PairGroupId, PairLegId, PairOutcome } from "./contracts";
import type { InitialLegTerminalState, PairGroupState } from "./states";

export const PAIR_EVENT_TYPES = [
  "PAIR_GROUP_CREATED",
  "PAIR_CASH_RESERVED",
  "PAIR_SCHEDULED",
  "PAIR_ACTIVATION_STARTED",
  "PAIR_ACTIVATION_REJECTED",
  "PAIR_ACTIVATION_APPROVED",
  "PAIR_LEG_PLANNED",
  "PAIR_LEG_EFFECT_ENQUEUED",
  "PAIR_LEG_EFFECT_CANCELED_UNCLAIMED",
  "PAIR_LEG_EFFECT_EXPIRED_UNCLAIMED",
  "PAIR_LEG_DISPATCH_CLAIMED",
  "PAIR_LEG_RESULT_RECORDED",
  "PAIR_FILL_RECORDED",
  "PAIR_LEG_OUTCOME_UNKNOWN",
  "PAIR_SERIAL_COMPLEMENT_SCHEDULED",
  "PAIR_SERIAL_COMPLEMENT_DUE",
  "PAIR_SERIAL_COMPLEMENT_REJECTED",
  "PAIR_INVENTORY_RECOMPUTED",
  "PAIR_LEG_SKIPPED",
  "PAIR_CLASSIFIED_NO_INITIAL_FILL",
  "PAIR_CLASSIFIED_PAIRED",
  "PAIR_CLASSIFIED_RESIDUAL",
  "PAIR_SETTLEMENT_STARTED",
  "PAIR_SETTLEMENT_DEFERRED",
  "PAIR_RECOVERY_ALTERNATIVES_CAPTURED",
  "PAIR_RECOVERY_SKIPPED",
  "PAIR_RECOVERY_EFFECT_ENQUEUED",
  "PAIR_RECOVERY_RESULT_RECORDED",
  "PAIR_RECOVERY_OUTCOME_UNKNOWN",
  "PAIR_VIRTUAL_MERGE_ENQUEUED",
  "PAIR_VIRTUAL_MERGE_CONFIRMED",
  "PAIR_VIRTUAL_MERGE_FAILED",
  "PAIR_VIRTUAL_MERGE_OUTCOME_UNKNOWN",
  "PAIR_RESOLUTION_APPLIED",
  "PAIR_RESERVATION_RELEASED",
  "PAIR_RECONCILIATION_STARTED",
  "PAIR_PROJECTION_REBUILT",
  "PAIR_RECONCILIATION_OK",
  "PAIR_RECONCILIATION_MISMATCH",
  "PAIR_HALTED",
  "PAIR_GROUP_CLOSED",
] as const;

export type PairEventType = (typeof PAIR_EVENT_TYPES)[number];

interface EventBase<Type extends PairEventType, Payload> {
  readonly type: Type;
  readonly schemaVersion: 1;
  readonly eventId: PairEventId;
  readonly groupId: PairGroupId;
  readonly causationId: string;
  readonly occurredAtMs: number;
  readonly payload: Readonly<Payload>;
}

type Empty = Readonly<Record<string, never>>;
type LegRef = { readonly outcome: PairOutcome };

export type PairGroupCreatedEvent = EventBase<"PAIR_GROUP_CREATED", {
  readonly dispatchModel: PairDispatchModel;
  readonly upLegId: PairLegId;
  readonly downLegId: PairLegId;
  readonly targetGrossShares6: bigint;
  readonly approvedCashCap6: bigint;
  readonly approvedResidualLoss6: bigint;
}>;

export type PairGroupEvent =
  | PairGroupCreatedEvent
  | EventBase<"PAIR_CASH_RESERVED", { readonly reservedCash6: bigint }>
  | EventBase<"PAIR_SCHEDULED", Empty>
  | EventBase<"PAIR_ACTIVATION_STARTED", Empty>
  | EventBase<"PAIR_ACTIVATION_REJECTED", { readonly reasonCodes: readonly string[] }>
  | EventBase<"PAIR_ACTIVATION_APPROVED", Empty>
  | EventBase<"PAIR_LEG_PLANNED", LegRef & { readonly requestedGrossShares6: bigint }>
  | EventBase<"PAIR_LEG_EFFECT_ENQUEUED", LegRef & { readonly effectId: string }>
  | EventBase<"PAIR_LEG_EFFECT_CANCELED_UNCLAIMED", LegRef & { readonly effectId: string }>
  | EventBase<"PAIR_LEG_EFFECT_EXPIRED_UNCLAIMED", LegRef & { readonly effectId: string }>
  | EventBase<"PAIR_LEG_DISPATCH_CLAIMED", LegRef & { readonly effectId: string; readonly actualDispatchAtMs: number }>
  | EventBase<"PAIR_LEG_RESULT_RECORDED", LegRef & {
      readonly evidenceKey: string;
      readonly result: Exclude<InitialLegTerminalState, "SKIPPED">;
      readonly filledGrossShares6: bigint;
    }>
  | EventBase<"PAIR_FILL_RECORDED", LegRef & {
      readonly evidenceKey: string;
      readonly grossShares6: bigint;
      readonly netShares6: bigint;
      readonly cashDebit6: bigint;
      readonly safetyBreach?: boolean;
    }>
  | EventBase<"PAIR_LEG_OUTCOME_UNKNOWN", LegRef & { readonly evidenceKey: string }>
  | EventBase<"PAIR_SERIAL_COMPLEMENT_SCHEDULED", LegRef & { readonly dueAtMs: number }>
  | EventBase<"PAIR_SERIAL_COMPLEMENT_DUE", LegRef & { readonly dueAtMs: number }>
  | EventBase<"PAIR_SERIAL_COMPLEMENT_REJECTED", LegRef & { readonly reasonCodes: readonly string[] }>
  | EventBase<"PAIR_INVENTORY_RECOMPUTED", {
      readonly upHeldShares6: bigint;
      readonly downHeldShares6: bigint;
      readonly currentWorstCaseLoss6: bigint;
      readonly safetyBreach?: boolean;
    }>
  | EventBase<"PAIR_LEG_SKIPPED", LegRef & { readonly reason: string }>
  | EventBase<"PAIR_CLASSIFIED_NO_INITIAL_FILL", Empty>
  | EventBase<"PAIR_CLASSIFIED_PAIRED", Empty>
  | EventBase<"PAIR_CLASSIFIED_RESIDUAL", Empty>
  | EventBase<"PAIR_SETTLEMENT_STARTED", Empty>
  | EventBase<"PAIR_SETTLEMENT_DEFERRED", { readonly reason: string }>
  | EventBase<"PAIR_RECOVERY_ALTERNATIVES_CAPTURED", { readonly eligibleAttempt: boolean }>
  | EventBase<"PAIR_RECOVERY_SKIPPED", { readonly reason: string }>
  | EventBase<"PAIR_RECOVERY_EFFECT_ENQUEUED", { readonly effectId: string }>
  | EventBase<"PAIR_RECOVERY_RESULT_RECORDED", {
      readonly evidenceKey: string;
      readonly upHeldShares6: bigint;
      readonly downHeldShares6: bigint;
      readonly cashDebit6: bigint;
      readonly cashCredit6: bigint;
      readonly currentWorstCaseLoss6: bigint;
      readonly safetyBreach?: boolean;
    }>
  | EventBase<"PAIR_RECOVERY_OUTCOME_UNKNOWN", { readonly evidenceKey: string }>
  | EventBase<"PAIR_VIRTUAL_MERGE_ENQUEUED", { readonly effectId: string }>
  | EventBase<"PAIR_VIRTUAL_MERGE_CONFIRMED", { readonly evidenceKey: string; readonly cashCredit6: bigint }>
  | EventBase<"PAIR_VIRTUAL_MERGE_FAILED", { readonly evidenceKey: string; readonly reason: string }>
  | EventBase<"PAIR_VIRTUAL_MERGE_OUTCOME_UNKNOWN", { readonly evidenceKey: string }>
  | EventBase<"PAIR_RESOLUTION_APPLIED", { readonly resolutionId: string; readonly cashCredit6: bigint }>
  | EventBase<"PAIR_RESERVATION_RELEASED", { readonly releasedCash6: bigint }>
  | EventBase<"PAIR_RECONCILIATION_STARTED", Empty>
  | EventBase<"PAIR_PROJECTION_REBUILT", {
      readonly upHeldShares6: bigint;
      readonly downHeldShares6: bigint;
      readonly reservedCash6: bigint;
      readonly cashDebits6: bigint;
      readonly cashCredits6: bigint;
      readonly currentWorstCaseLoss6: bigint;
      readonly safetyBreach?: boolean;
    }>
  | EventBase<"PAIR_RECONCILIATION_OK", { readonly terminalState: "RECONCILED_FLAT" | "RECONCILED_SETTLED" }>
  | EventBase<"PAIR_RECONCILIATION_MISMATCH", { readonly diffCodes: readonly string[] }>
  | EventBase<"PAIR_HALTED", { readonly reason: string }>
  | EventBase<"PAIR_GROUP_CLOSED", { readonly terminalState: "RECONCILED_FLAT" | "RECONCILED_SETTLED" }>;

export type PairEventOfType<Type extends PairEventType> = Extract<PairGroupEvent, { readonly type: Type }>;

export function pairEventDedupeKeys(event: PairGroupEvent): readonly string[] {
  const keys = [`causation:${event.causationId}`];
  if ("evidenceKey" in event.payload) keys.push(`evidence:${event.payload.evidenceKey}`);
  if (event.type === "PAIR_RESOLUTION_APPLIED") keys.push(`resolution:${event.payload.resolutionId}`);
  return keys;
}

export function isPairEventType(value: string): value is PairEventType {
  return (PAIR_EVENT_TYPES as readonly string[]).includes(value);
}

export type PairStateEvent = { readonly state: PairGroupState; readonly eventType: PairEventType };

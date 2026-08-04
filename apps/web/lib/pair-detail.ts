export type PairJson = string | number | boolean | null | readonly PairJson[] | PairJsonObject;
export interface PairJsonObject { readonly [key: string]: PairJson | undefined }
export type PairRecord = PairJsonObject;

export interface PairEffectRow extends PairRecord {
  readonly id: string;
  readonly actionKind?: string;
  readonly actionSequence?: number;
  readonly effectOrdinal?: number;
  readonly state?: string;
  readonly resultEvidenceId?: string | null;
  readonly lastErrorCode?: string | null;
  readonly notBeforeMs?: number;
  readonly deadlineMs?: number;
  readonly requestPayload?: PairRecord;
}

export interface PairEvidenceRow extends PairRecord {
  readonly id: string;
  readonly effectId?: string | null;
  readonly evidenceKey?: string;
  readonly evidenceKind?: string;
  readonly payload?: PairRecord;
  readonly sourceTsMs?: number | null;
  readonly receivedTsMs?: number;
  readonly processingResult?: string | null;
}

export interface PairGroupEvent extends PairRecord {
  readonly id: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly causationId?: string;
  readonly correlationId?: string;
  readonly payload: PairRecord;
  readonly occurredAtMs: number;
  readonly recordedAtMs?: number;
}

export interface PairReconciliationDiff extends PairRecord {
  readonly id: string;
  readonly severity: string;
  readonly code: string;
  readonly expectedJson?: PairJson;
  readonly actualJson?: PairJson;
  readonly autoRepairable?: boolean;
  readonly repairedAtMs?: number | null;
}

export interface PairReconciliation extends PairRecord {
  readonly id: string;
  readonly cause: string;
  readonly status: string;
  readonly startedAtMs: number;
  readonly completedAtMs?: number | null;
  readonly checkedEventSequence?: number | null;
  readonly projectionRebuilt?: boolean;
  readonly summary?: PairJson;
  readonly diffs?: readonly PairReconciliationDiff[];
}

export interface PairGroupDetail extends PairRecord {
  readonly id: string;
  readonly marketId: string;
  readonly conditionId?: string;
  readonly observationId?: string;
  readonly episodeId?: string | null;
  readonly pairAccountId?: string;
  readonly signalDecisionId?: string;
  readonly signalRiskDecisionId?: string;
  readonly activationDecisionId?: string | null;
  readonly activationRiskDecisionId?: string | null;
  readonly strategyVersion: string;
  readonly mode: string;
  readonly route: string;
  readonly dispatchModel: string;
  readonly settlementPolicy: string;
  readonly recoveryPolicy: string;
  readonly idempotencyKey?: string;
  readonly requestHash?: string;
  readonly signalCaptureId: string;
  readonly activationCaptureId?: string | null;
  readonly secondLegCaptureId?: string | null;
  readonly state: string;
  readonly stateVersion?: number;
  readonly targetGrossShares6: string;
  readonly approvedCashCap6: string;
  readonly approvedResidualLoss6: string;
  readonly reservedCash6: string;
  readonly cashDebits6?: string;
  readonly cashCredits6?: string;
  readonly cashFees6?: string;
  readonly settlementCosts6?: string;
  readonly upHeldShares6: string;
  readonly downHeldShares6: string;
  readonly matchedShares6: string;
  readonly residualSide?: string | null;
  readonly residualShares6: string;
  readonly currentWorstCaseLoss6: string;
  readonly peakWorstCaseLoss6?: string;
  readonly signalNetPnl6: string;
  readonly activationNetPnl6?: string | null;
  readonly realizedPairPnl6?: string | null;
  readonly realizedRecoveryPnl6?: string;
  readonly unrealizedResidualMark6?: string | null;
  readonly oneTickWorsePnl6?: string | null;
  readonly twoTicksWorsePnl6?: string | null;
  readonly stressResultsJson?: PairJson;
  readonly activateAtMs: number;
  readonly nextActionAtMs?: number | null;
  readonly recoveryDeadlineMs?: number | null;
  readonly recoveryAttempts?: number;
  readonly reconciliationStatus: string;
  readonly lastReconciledAtMs?: number | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly closedAtMs?: number | null;
  readonly haltedAtMs?: number | null;
  readonly haltReason?: string | null;
  readonly actions?: readonly PairRecord[];
  readonly effects?: readonly PairEffectRow[];
  readonly inventoryLots?: readonly PairRecord[];
  readonly inventoryConsumptions?: readonly PairRecord[];
  readonly ledgerEntries?: readonly PairRecord[];
  readonly evidence?: readonly PairEvidenceRow[];
}

export interface PairPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export type PairTimelineStage =
  | "Signal capture" | "Signal quote" | "Risk decision" | "Reservation"
  | "Scheduled activation" | "Activation capture / requote" | "Leg effects / fills"
  | "Inventory classification" | "Recovery" | "Settlement / resolution" | "Reconciliation" | "Lifecycle";

export function timelineStage(eventType: string): PairTimelineStage {
  const type = eventType.toUpperCase();
  if (type.includes("RECONCIL")) return "Reconciliation";
  if (type.includes("RECOVERY")) return "Recovery";
  if (type.includes("SETTLE") || type.includes("MERGE") || type.includes("RESOLUTION")) return "Settlement / resolution";
  if (type.includes("INVENTORY") || type.includes("RESIDUAL") || type.includes("PAIRED")) return "Inventory classification";
  if (type.includes("FILL") || type.includes("LEG") || type.includes("EFFECT")) return "Leg effects / fills";
  if (type.includes("ACTIVATION_CAPTURE") || type.includes("REQUOTE")) return "Activation capture / requote";
  if (type.includes("ACTIVATION")) return "Scheduled activation";
  if (type.includes("RESERV")) return "Reservation";
  if (type.includes("RISK")) return "Risk decision";
  if (type.includes("QUOTE") || type.includes("OBSERVATION")) return "Signal quote";
  if (type.includes("CAPTURE") || type.includes("CREATED")) return "Signal capture";
  return "Lifecycle";
}

export function orderedEvents(events: readonly PairGroupEvent[]): readonly PairGroupEvent[] {
  return [...events].sort((left, right) => left.sequence - right.sequence || left.occurredAtMs - right.occurredAtMs || left.id.localeCompare(right.id));
}

export function outcomeOf(row: PairRecord): "UP" | "DOWN" | null {
  const direct = row.outcome ?? row.side ?? row.outcomeSide;
  if (direct === "UP" || direct === "DOWN") return direct;
  const request = recordOf(row.requestPayload);
  const nested = request?.outcome ?? request?.side ?? request?.outcomeSide;
  return nested === "UP" || nested === "DOWN" ? nested : null;
}

export function recordOf(value: PairJson | undefined): PairRecord | null {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
    ? value as PairRecord
    : null;
}

export function exactFields(record: PairRecord | null | undefined): readonly [string, string][] {
  if (!record) return [];
  return Object.entries(record)
    .filter(([key, value]) => typeof value === "string" && /(?:6|amount|shares|pnl|fee|cost|cash|price|loss|delta)$/i.test(key))
    .map(([key, value]) => [key, value as string] as const);
}

export function timelineTiming(event: PairGroupEvent): { scheduled: number | null; actual: number; delay: number | null } {
  const scheduledValue = event.payload.scheduledAtMs ?? event.payload.scheduledDueMs ?? event.payload.activateAtMs ?? null;
  const actualValue = event.payload.actualAtMs ?? event.payload.actualDispatchAtMs ?? event.occurredAtMs;
  const scheduled = typeof scheduledValue === "number" && Number.isSafeInteger(scheduledValue) ? scheduledValue : null;
  const actual = typeof actualValue === "number" && Number.isSafeInteger(actualValue) ? actualValue : event.occurredAtMs;
  return { scheduled, actual, delay: scheduled === null ? null : actual - scheduled };
}

export function evidenceReference(event: PairGroupEvent): string | null {
  const value = event.payload.evidenceId ?? event.payload.evidenceKey ?? event.payload.resultEvidenceId;
  return typeof value === "string" ? value : null;
}

import { schema, type DbHandle } from "@b5p/db";
import { canonicalJsonValue, canonicalObjectHash, type PairGroupId } from "@b5p/pair-execution";
import {
  comparePairReconciliation,
  reducePairGroupOrThrow,
  replayPairGroup,
  type PairAdapterObservation,
  type PairEffectReconciliationRecord,
  type PairGroupAggregate,
  type PairGroupEvent,
  type PairReconciliationDiff,
  type PairStoredProjection,
} from "@b5p/pair-execution/internal/reconciliation";
import { and, asc, eq, inArray } from "drizzle-orm";
import { PairAccountStore, type PairAccountState } from "./pair-account-store";
import { ACTIVE_PAIR_GROUP_STATES, PairStore, type PairOrderGroupRow } from "./pair-store";

const BIGINT_PAYLOAD_FIELDS = new Set([
  "targetGrossShares6", "approvedCashCap6", "approvedResidualLoss6", "reservedCash6",
  "requestedGrossShares6", "filledGrossShares6", "grossShares6", "netShares6",
  "cashDebit6", "cashCredit6", "upHeldShares6", "downHeldShares6",
  "currentWorstCaseLoss6", "releasedCash6",
]);

export type PairStartupReconciliationStatus = "HEALTHY" | "BLOCKED";

export interface PairGroupReconciliationSummary {
  readonly reconciliationId: string;
  readonly groupId: string;
  readonly status: "HEALTHY" | "PENDING_OBSERVATION" | "MANUAL_REVIEW";
  readonly schedulingAllowed: boolean;
  readonly projectionRebuilt: boolean;
  readonly diffCodes: readonly string[];
}

export interface PairStartupReconciliationResult {
  readonly runKey: string;
  readonly status: PairStartupReconciliationStatus;
  readonly observerAllowed: true;
  readonly paperSchedulingAllowed: boolean;
  readonly groups: readonly PairGroupReconciliationSummary[];
  readonly accounts: readonly PairAccountReconciliationSummary[];
}

export interface PairAccountReconciliationSummary {
  readonly reconciliationId: string;
  readonly accountId: string;
  readonly groupId: null;
  readonly status: "HEALTHY" | "MANUAL_REVIEW";
  readonly schedulingAllowed: boolean;
  /**
   * Exact account-only mismatches live here because the current
   * pair_reconciliation_diffs schema requires a non-null group foreign key.
   */
  readonly diffs: readonly PairReconciliationDiff[];
}

export interface PairStartupReconciliationInput {
  /** Stable process-start identity. Reusing it is an idempotent read. */
  readonly runKey: string;
  readonly nowMs: number;
}

export class PairStartupReconciliationError extends Error {}
export class PairStartupReconciliationValidationError extends PairStartupReconciliationError {}
export class PairStartupReconciliationConcurrentChangeError extends PairStartupReconciliationError {}

function assertIdentity(value: string, label: string): void {
  if (value.length === 0) throw new PairStartupReconciliationValidationError(`${label} must be non-empty`);
}

function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PairStartupReconciliationValidationError("reconciliation time must be a non-negative safe integer");
  }
}

function hydratePayload(value: unknown, key = ""): unknown {
  if (BIGINT_PAYLOAD_FIELDS.has(key)) {
    if (typeof value !== "string" || !/^-?(0|[1-9]\d*)$/.test(value)) {
      throw new PairStartupReconciliationError(`persisted ${key} is not a canonical integer string`);
    }
    return BigInt(value);
  }
  if (Array.isArray(value)) return value.map((item) => hydratePayload(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, hydratePayload(child, childKey)]));
  }
  return value;
}

function persistedEvent(row: typeof schema.pairGroupEvents.$inferSelect): PairGroupEvent {
  return {
    type: row.eventType,
    schemaVersion: row.eventSchemaVersion,
    eventId: row.id,
    groupId: row.groupId,
    causationId: row.causationId,
    occurredAtMs: row.occurredAtMs,
    payload: hydratePayload(row.payload),
  } as PairGroupEvent;
}

function storedProjection(group: PairOrderGroupRow): PairStoredProjection {
  return {
    state: group.state,
    stateVersion: group.stateVersion,
    eventCount: group.eventSequence,
    reservedCash6: group.reservedCash6,
    cashDebits6: group.cashDebits6,
    cashCredits6: group.cashCredits6,
    upHeldShares6: group.upHeldShares6,
    downHeldShares6: group.downHeldShares6,
    matchedShares6: group.matchedShares6,
    residualShares6: group.residualShares6,
    realizedPnl6: group.realizedPairPnl6 ?? 0n,
  };
}

function repairPatch(aggregate: PairGroupAggregate, realizedPnl6: bigint, nowMs: number) {
  return {
    state: aggregate.state,
    stateVersion: aggregate.stateVersion,
    eventSequence: aggregate.eventCount,
    reservedCash6: aggregate.reservedCash6,
    cashDebits6: aggregate.cashDebits6,
    cashCredits6: aggregate.cashCredits6,
    upHeldShares6: aggregate.upHeldShares6,
    downHeldShares6: aggregate.downHeldShares6,
    matchedShares6: aggregate.matchedShares6,
    residualSide: aggregate.residualSide,
    residualShares6: aggregate.residualShares6,
    currentWorstCaseLoss6: aggregate.currentWorstCaseLoss6,
    peakWorstCaseLoss6: aggregate.peakWorstCaseLoss6,
    nextActionAtMs: aggregate.nextActionAtMs,
    recoveryAttempts: aggregate.recoveryAttempts,
    haltedAtMs: aggregate.haltedAtMs,
    haltReason: aggregate.haltReason,
    realizedPairPnl6: realizedPnl6,
    reconciliationStatus: "HEALTHY",
    lastReconciledAtMs: nowMs,
    closedAtMs: aggregate.closedAtMs,
    updatedAtMs: nowMs,
  } as const;
}

function effectState(state: string): PairEffectReconciliationRecord["state"] {
  if (state === "PENDING") return "PENDING";
  if (state === "CLAIMED") return "CLAIMED";
  if (state === "OUTCOME_UNKNOWN") return "UNKNOWN";
  return "TERMINAL";
}

function observedStatus(state: string): PairAdapterObservation["status"] {
  if (state === "FILLED" || state === "MERGE_CONFIRMED") return "FILLED";
  if (state === "NO_FILL" || state === "PARTIAL_CANCELED") return "NO_FILL";
  if (state === "TERMINAL_REJECTED" || state === "MERGE_FAILED") return "REJECTED";
  if (state === "OUTCOME_UNKNOWN") return "UNKNOWN";
  return "UNKNOWN";
}

function diff(input: {
  code: string;
  expected: string | number | bigint | null;
  actual: string | number | bigint | null;
  subjectId?: string | null;
  repair?: boolean;
}): PairReconciliationDiff {
  return {
    code: input.code,
    severity: input.repair ? "ERROR" : "CRITICAL",
    action: input.repair ? "REBUILD_PROJECTION" : "MANUAL_REVIEW",
    subjectId: input.subjectId ?? null,
    expected: input.expected === null ? null : String(input.expected),
    actual: input.actual === null ? null : String(input.actual),
    autoRepairable: input.repair === true,
  };
}

function accountProjectionDiffs(
  state: PairAccountState,
  allAccountGroups: readonly PairOrderGroupRow[],
): readonly PairReconciliationDiff[] {
  const expectedJournalCount = new Set(state.ledgerEntries.map(({ journalId }) => journalId)).size;
  const activeCount = allAccountGroups.filter(({ state: groupState }) =>
    (ACTIVE_PAIR_GROUP_STATES as readonly string[]).includes(groupState)).length;
  const aggregateWorstCaseLoss6 = allAccountGroups.reduce((sum, group) => sum + group.currentWorstCaseLoss6, 0n);
  const checks: readonly [string, string | number | bigint, string | number | bigint][] = [
    ["ACCOUNT_CASH_AVAILABLE_MISMATCH", state.ledger.cashAvailable6, state.account.cashAvailable6],
    ["ACCOUNT_CASH_RESERVED_MISMATCH", state.ledger.cashReserved6, state.account.cashReserved6],
    ["ACCOUNT_REALIZED_PNL_MISMATCH", state.ledger.terminalRealizedPnl6, state.account.realizedPnl6],
    ["ACCOUNT_EVENT_SEQUENCE_MISMATCH", expectedJournalCount, state.account.eventSequence],
    ["ACCOUNT_STATE_VERSION_MISMATCH", expectedJournalCount, state.account.stateVersion],
    ["ACCOUNT_ACTIVE_GROUP_COUNT_MISMATCH", activeCount, state.account.activeGroupCount],
    ["ACCOUNT_AGGREGATE_WORST_LOSS_MISMATCH", aggregateWorstCaseLoss6, state.account.aggregateWorstCaseLoss6],
  ];
  return checks
    .filter(([, expected, actual]) => expected !== actual)
    .map(([code, expected, actual]) => diff({ code, expected, actual, subjectId: state.account.id, repair: true }));
}

function accountRepairPatch(state: PairAccountState, allAccountGroups: readonly PairOrderGroupRow[], nowMs: number) {
  const activeGroupCount = allAccountGroups.filter(({ state: groupState }) =>
    (ACTIVE_PAIR_GROUP_STATES as readonly string[]).includes(groupState)).length;
  return {
    cashAvailable6: state.ledger.cashAvailable6,
    cashReserved6: state.ledger.cashReserved6,
    realizedPnl6: state.ledger.terminalRealizedPnl6,
    activeGroupCount,
    aggregateWorstCaseLoss6: allAccountGroups.reduce((sum, group) => sum + group.currentWorstCaseLoss6, 0n),
    eventSequence: new Set(state.ledgerEntries.map(({ journalId }) => journalId)).size,
    stateVersion: new Set(state.ledgerEntries.map(({ journalId }) => journalId)).size,
    reconciliationStatus: "HEALTHY",
    lastReconciledAtMs: nowMs,
    updatedAtMs: nowMs,
  } as const;
}

function reconciliationId(runKey: string, groupId: string): string {
  return `pair-recon-${canonicalObjectHash({ runKey, groupId }).slice(0, 32)}`;
}

function accountReconciliationId(runKey: string, accountId: string): string {
  return `pair-account-recon-${canonicalObjectHash({ runKey, accountId }).slice(0, 32)}`;
}

function diffId(runId: string, item: PairReconciliationDiff, ordinal: number): string {
  return `pair-recon-diff-${canonicalObjectHash({ runId, ordinal, ...item }).slice(0, 32)}`;
}

function rebuildEventId(runId: string): string {
  return `pair-event-${canonicalObjectHash({ runId, type: "PAIR_PROJECTION_REBUILT" }).slice(0, 32)}`;
}

function canAppendProjectionRebuild(aggregate: PairGroupAggregate): boolean {
  return aggregate.state === "RECONCILING" || aggregate.state === "MANUAL_REVIEW";
}

/** Durable, read-only-with-respect-to-effects startup reconciliation gate. */
export class PairStartupReconciler {
  private readonly pairStore: PairStore;
  private readonly accountStore: PairAccountStore;

  constructor(private readonly handle: DbHandle) {
    this.pairStore = new PairStore(handle);
    this.accountStore = new PairAccountStore(handle);
  }

  async reconcileStartup(input: PairStartupReconciliationInput): Promise<PairStartupReconciliationResult> {
    assertIdentity(input.runKey, "startup run key");
    assertTimestamp(input.nowMs);
    const groups = await this.handle.db.select().from(schema.pairOrderGroups)
      .orderBy(asc(schema.pairOrderGroups.createdAtMs), asc(schema.pairOrderGroups.id));
    const summaries: PairGroupReconciliationSummary[] = [];
    const reconciledAccounts = new Set<string>();
    for (const group of groups) {
      summaries.push(await this.reconcileGroup({
        runId: reconciliationId(input.runKey, group.id),
        group,
        nowMs: input.nowMs,
        reconcileAccountProjection: !reconciledAccounts.has(group.pairAccountId),
      }));
      reconciledAccounts.add(group.pairAccountId);
    }
    const accounts = await this.handle.db.select().from(schema.pairPaperAccounts)
      .orderBy(asc(schema.pairPaperAccounts.createdAtMs), asc(schema.pairPaperAccounts.id));
    const accountSummaries: PairAccountReconciliationSummary[] = [];
    for (const account of accounts) {
      if (reconciledAccounts.has(account.id)) continue;
      accountSummaries.push(await this.reconcileStandaloneAccount({
        runId: accountReconciliationId(input.runKey, account.id),
        accountId: account.id,
        nowMs: input.nowMs,
      }));
    }
    const paperSchedulingAllowed = summaries.every(({ schedulingAllowed }) => schedulingAllowed)
      && accountSummaries.every(({ schedulingAllowed }) => schedulingAllowed);
    return {
      runKey: input.runKey,
      status: paperSchedulingAllowed ? "HEALTHY" : "BLOCKED",
      observerAllowed: true,
      paperSchedulingAllowed,
      groups: summaries,
      accounts: accountSummaries,
    };
  }

  private async reconcileStandaloneAccount(input: {
    readonly runId: string;
    readonly accountId: string;
    readonly nowMs: number;
  }): Promise<PairAccountReconciliationSummary> {
    const prior = await this.handle.db.select().from(schema.pairReconciliations)
      .where(eq(schema.pairReconciliations.id, input.runId)).limit(1);
    if (prior[0]?.completedAtMs !== null && prior[0] !== undefined) {
      return prior[0].summary as unknown as PairAccountReconciliationSummary;
    }

    let state: PairAccountState | null;
    let diffs: readonly PairReconciliationDiff[];
    try {
      state = await this.accountStore.loadAuthoritativeState(input.accountId);
      diffs = state === null
        ? [diff({ code: "PAIR_ACCOUNT_MISSING", expected: input.accountId, actual: null, subjectId: input.accountId })]
        : accountProjectionDiffs(state, []);
    } catch (error) {
      state = null;
      diffs = [diff({
        code: error instanceof Error && error.message.startsWith("UNBALANCED_JOURNAL")
          ? "UNBALANCED_LEDGER_JOURNAL"
          : "ACCOUNT_AUTHORITATIVE_REPLAY_FAILED",
        expected: "valid immutable ledger replay",
        actual: error instanceof Error ? error.message : "unknown account replay failure",
        subjectId: input.accountId,
      })];
    }
    const healthy = state !== null && diffs.length === 0;
    const summary: PairAccountReconciliationSummary = {
      reconciliationId: input.runId,
      accountId: input.accountId,
      groupId: null,
      status: healthy ? "HEALTHY" : "MANUAL_REVIEW",
      schedulingAllowed: healthy,
      diffs,
    };
    await this.handle.db.transaction(async (tx) => {
      await tx.insert(schema.pairReconciliations).values({
        id: input.runId,
        groupId: null,
        cause: "STARTUP_ACCOUNT_ONLY",
        startedAtMs: input.nowMs,
        completedAtMs: input.nowMs,
        status: summary.status,
        checkedEventSequence: state?.account.eventSequence ?? null,
        projectionRebuilt: false,
        // Full diff detail is retained here; pair_reconciliation_diffs cannot
        // represent an account without inventing a group identity.
        summary: canonicalJsonValue(summary) as never,
        createdAtMs: input.nowMs,
      });
      if (state !== null) {
        const updated = await tx.update(schema.pairPaperAccounts).set({
          reconciliationStatus: healthy ? "HEALTHY" : "MISMATCH",
          lastReconciledAtMs: input.nowMs,
          updatedAtMs: input.nowMs,
        }).where(and(
          eq(schema.pairPaperAccounts.id, input.accountId),
          eq(schema.pairPaperAccounts.stateVersion, state.account.stateVersion),
        )).returning();
        if (updated[0] === undefined) {
          throw new PairStartupReconciliationConcurrentChangeError("standalone pair account changed during startup reconciliation");
        }
      }
    });
    return summary;
  }

  private async reconcileGroup(input: {
    readonly runId: string;
    readonly group: PairOrderGroupRow;
    readonly nowMs: number;
    readonly reconcileAccountProjection: boolean;
  }): Promise<PairGroupReconciliationSummary> {
    const prior = await this.handle.db.select().from(schema.pairReconciliations)
      .where(eq(schema.pairReconciliations.id, input.runId)).limit(1);
    if (prior[0]?.completedAtMs !== null && prior[0] !== undefined) {
      return prior[0].summary as unknown as PairGroupReconciliationSummary;
    }

    const eventRows = await this.pairStore.listEvents(input.group.id);
    let aggregate: PairGroupAggregate;
    try {
      aggregate = replayPairGroup(eventRows.map(persistedEvent));
    } catch (error) {
      const fatal = diff({
        code: "EVENT_REPLAY_FAILED",
        expected: "valid complete reducer replay",
        actual: error instanceof Error ? error.message : "unknown replay failure",
        subjectId: input.group.id,
      });
      return this.persistBlockedRun(input, eventRows.length, [fatal]);
    }

    let accountState: PairAccountState | null;
    try {
      accountState = await this.accountStore.loadAuthoritativeState(input.group.pairAccountId);
    } catch (error) {
      return this.persistBlockedRun(input, eventRows.length, [diff({
        code: error instanceof Error && error.message.startsWith("UNBALANCED_JOURNAL")
          ? "UNBALANCED_LEDGER_JOURNAL"
          : "ACCOUNT_AUTHORITATIVE_REPLAY_FAILED",
        expected: "valid immutable ledger replay",
        actual: error instanceof Error ? error.message : "unknown account replay failure",
        subjectId: input.group.pairAccountId,
      })]);
    }
    if (accountState === null) {
      return this.persistBlockedRun(input, eventRows.length, [diff({
        code: "PAIR_ACCOUNT_MISSING",
        expected: input.group.pairAccountId,
        actual: null,
        subjectId: input.group.id,
      })]);
    }
    const accountGroups = await this.handle.db.select().from(schema.pairOrderGroups)
      .where(eq(schema.pairOrderGroups.pairAccountId, input.group.pairAccountId));

    const orders = await this.handle.db.select().from(schema.orders)
      .where(eq(schema.orders.pairGroupId, input.group.id)).orderBy(asc(schema.orders.id));
    const fills = orders.length === 0 ? [] : await this.handle.db.select().from(schema.orderFills)
      .where(inArray(schema.orderFills.orderId, orders.map(({ id }) => id))).orderBy(asc(schema.orderFills.id));
    const effects = await this.handle.db.select().from(schema.pairEffectOutbox)
      .where(eq(schema.pairEffectOutbox.groupId, input.group.id)).orderBy(asc(schema.pairEffectOutbox.id));
    const evidence = await this.handle.db.select().from(schema.pairInboxEvidence)
      .where(eq(schema.pairInboxEvidence.groupId, input.group.id)).orderBy(asc(schema.pairInboxEvidence.id));
    const operations = effects.length === 0 ? [] : await this.handle.db.select().from(schema.pairPaperVenueOperations)
      .where(inArray(schema.pairPaperVenueOperations.effectId, effects.map(({ id }) => id)))
      .orderBy(asc(schema.pairPaperVenueOperations.createdAtMs), asc(schema.pairPaperVenueOperations.id));
    const evidenceById = new Map(evidence.map((item) => [item.id, item]));
    const evidenceByEffect = new Map(evidence.filter(({ effectId }) => effectId !== null).map((item) => [item.effectId!, item]));
    const operationByEffect = new Map(operations.map((item) => [item.effectId, item]));

    const sourceDiffs: PairReconciliationDiff[] = [];
    for (const fill of fills) {
      if (fill.netShares6 === null || fill.sourceEvidenceId === null || !evidenceById.has(fill.sourceEvidenceId)) {
        sourceDiffs.push(diff({
          code: "FILL_EVIDENCE_INCOMPLETE",
          expected: "net shares and durable source evidence",
          actual: `${fill.netShares6 === null ? "missing-net" : "net-ok"}/${fill.sourceEvidenceId ?? "missing-evidence"}`,
          subjectId: fill.id,
        }));
      }
    }
    for (const effect of effects) {
      if (effectState(effect.state) === "TERMINAL" && (effect.resultEvidenceId === null || !evidenceById.has(effect.resultEvidenceId))) {
        sourceDiffs.push(diff({
          code: "TERMINAL_EFFECT_MISSING_DURABLE_EVIDENCE",
          expected: "linked inbox evidence",
          actual: effect.resultEvidenceId,
          subjectId: effect.id,
        }));
      }
    }

    const result = comparePairReconciliation({
      groupId: input.group.id as PairGroupId,
      upTokenId: input.group.marketId === "" ? "" : this.tokenIdForOutcome(orders, accountState, input.group.id, "UP"),
      downTokenId: input.group.marketId === "" ? "" : this.tokenIdForOutcome(orders, accountState, input.group.id, "DOWN"),
      eventDerived: aggregate,
      eventSequenceNumbers: eventRows.map(({ sequence }) => sequence),
      projection: storedProjection(input.group),
      ledgerEntries: accountState.ledgerEntries,
      lots: accountState.lots,
      consumptions: accountState.consumptions,
      orders: orders.map((order) => ({ orderId: order.id, groupId: input.group.id as PairGroupId, requestedShares6: order.shares6 })),
      fills: fills.map((fill) => ({
        fillId: fill.id,
        evidenceKey: fill.sourceEvidenceId === null ? `missing:${fill.id}` : evidenceById.get(fill.sourceEvidenceId)?.evidenceKey ?? `missing:${fill.id}`,
        payloadHash: fill.sourceEvidenceId === null ? "missing" : evidenceById.get(fill.sourceEvidenceId)?.payloadHash ?? "missing",
        groupId: input.group.id as PairGroupId,
        orderId: fill.orderId,
        grossShares6: fill.shares6,
        netShares6: fill.netShares6 ?? -1n,
      })),
      effects: effects.map((effect) => ({
        effectId: effect.id,
        state: effectState(effect.state),
        claimToken: effect.claimToken,
        deadlineMs: effect.deadlineMs,
        resultEvidenceKey: effect.resultEvidenceId === null ? null : evidenceById.get(effect.resultEvidenceId)?.evidenceKey ?? null,
      })),
      adapterObservations: effects.map((effect): PairAdapterObservation => {
        const operation = operationByEffect.get(effect.id);
        const itemEvidence = evidenceByEffect.get(effect.id);
        return {
          effectId: effect.id,
          status: operation === undefined ? (effect.state === "PENDING" ? "ABSENT" : "UNKNOWN") : observedStatus(operation.state),
          evidenceKey: itemEvidence?.evidenceKey ?? null,
          payloadHash: operation?.resultHash ?? itemEvidence?.payloadHash ?? null,
        };
      }),
      nowMs: input.nowMs,
    });

    const allDiffs = [...result.diffs, ...sourceDiffs];
    if (input.reconcileAccountProjection) allDiffs.push(...accountProjectionDiffs(accountState, accountGroups));
    allDiffs.sort((a, b) => a.code.localeCompare(b.code) || (a.subjectId ?? "").localeCompare(b.subjectId ?? ""));
    const manual = allDiffs.some(({ action }) => action === "MANUAL_REVIEW");
    const pending = !manual && allDiffs.some(({ action }) => action === "RETAIN_AND_OBSERVE");
    const repairable = !manual && !pending && allDiffs.some(({ action }) => action === "REBUILD_PROJECTION");
    if (manual || pending) return this.persistBlockedRun(input, eventRows.length, allDiffs, pending ? "PENDING_OBSERVATION" : "MANUAL_REVIEW");
    if (repairable) {
      if (!result.projectionRebuildRequired) {
        return this.persistAccountRepair(input, aggregate.eventCount, accountState, accountGroups, allDiffs);
      }
      return this.persistRepair(input, aggregate, accountState, accountGroups, allDiffs, result.ledgerProjection?.terminalRealizedPnl6 ?? 0n);
    }
    return this.persistHealthyRun(input, eventRows.length, allDiffs);
  }

  private tokenIdForOutcome(
    orders: readonly (typeof schema.orders.$inferSelect)[],
    account: PairAccountState,
    groupId: string,
    outcome: "UP" | "DOWN",
  ): string {
    return orders.find((order) => order.outcomeSide === outcome)?.tokenId
      ?? account.lots.find((lot) => lot.groupId === groupId && lot.outcome === outcome)?.tokenId
      ?? `unobserved:${groupId}:${outcome}`;
  }

  private async persistHealthyRun(
    input: { readonly runId: string; readonly group: PairOrderGroupRow; readonly nowMs: number },
    checkedEventSequence: number,
    diffs: readonly PairReconciliationDiff[],
  ): Promise<PairGroupReconciliationSummary> {
    const summary: PairGroupReconciliationSummary = {
      reconciliationId: input.runId,
      groupId: input.group.id,
      status: "HEALTHY",
      schedulingAllowed: true,
      projectionRebuilt: false,
      diffCodes: diffs.map(({ code }) => code),
    };
    await this.persistRun(input, checkedEventSequence, diffs, summary, false);
    return summary;
  }

  private async persistBlockedRun(
    input: { readonly runId: string; readonly group: PairOrderGroupRow; readonly nowMs: number },
    checkedEventSequence: number,
    diffs: readonly PairReconciliationDiff[],
    status: "PENDING_OBSERVATION" | "MANUAL_REVIEW" = "MANUAL_REVIEW",
  ): Promise<PairGroupReconciliationSummary> {
    const summary: PairGroupReconciliationSummary = {
      reconciliationId: input.runId,
      groupId: input.group.id,
      status,
      schedulingAllowed: false,
      projectionRebuilt: false,
      diffCodes: diffs.map(({ code }) => code),
    };
    await this.persistRun(input, checkedEventSequence, diffs, summary, false);
    return summary;
  }

  private async persistRun(
    input: { readonly runId: string; readonly group: PairOrderGroupRow; readonly nowMs: number },
    checkedEventSequence: number,
    diffs: readonly PairReconciliationDiff[],
    summary: PairGroupReconciliationSummary,
    projectionRebuilt: boolean,
  ): Promise<void> {
    await this.handle.db.transaction(async (tx) => {
      await tx.insert(schema.pairReconciliations).values({
        id: input.runId,
        groupId: input.group.id,
        cause: "STARTUP",
        startedAtMs: input.nowMs,
        completedAtMs: input.nowMs,
        status: summary.status,
        checkedEventSequence,
        projectionRebuilt,
        summary: canonicalJsonValue(summary) as never,
        createdAtMs: input.nowMs,
      }).onConflictDoNothing();
      if (diffs.length > 0) {
        await tx.insert(schema.pairReconciliationDiffs).values(diffs.map((item, ordinal) => ({
          id: diffId(input.runId, item, ordinal),
          reconciliationId: input.runId,
          groupId: input.group.id,
          severity: item.severity,
          code: item.code,
          expectedJson: item.expected === null ? null : canonicalJsonValue({ value: item.expected }) as never,
          actualJson: item.actual === null ? null : canonicalJsonValue({ value: item.actual }) as never,
          autoRepairable: item.autoRepairable,
          repairedAtMs: null,
          createdAtMs: input.nowMs,
        }))).onConflictDoNothing();
      }
      await tx.update(schema.pairOrderGroups).set({
        reconciliationStatus: summary.status === "HEALTHY" ? "HEALTHY" : summary.status === "PENDING_OBSERVATION" ? "PENDING" : "MISMATCH",
        lastReconciledAtMs: input.nowMs,
        updatedAtMs: input.nowMs,
      }).where(and(
        eq(schema.pairOrderGroups.id, input.group.id),
        eq(schema.pairOrderGroups.stateVersion, input.group.stateVersion),
        eq(schema.pairOrderGroups.eventSequence, input.group.eventSequence),
      ));
    });
  }

  private async persistRepair(
    input: { readonly runId: string; readonly group: PairOrderGroupRow; readonly nowMs: number; readonly reconcileAccountProjection: boolean },
    aggregate: PairGroupAggregate,
    accountState: PairAccountState,
    accountGroups: readonly PairOrderGroupRow[],
    diffs: readonly PairReconciliationDiff[],
    realizedPnl6: bigint,
  ): Promise<PairGroupReconciliationSummary> {
    if (!canAppendProjectionRebuild(aggregate)) {
      const blocked = [...diffs, diff({
        code: "PROJECTION_REBUILD_EVENT_ILLEGAL",
        expected: "RECONCILING or MANUAL_REVIEW",
        actual: aggregate.state,
        subjectId: input.group.id,
      })];
      return this.persistBlockedRun(input, aggregate.eventCount, blocked);
    }
    const eventId = rebuildEventId(input.runId);
    const event: PairGroupEvent = {
      type: "PAIR_PROJECTION_REBUILT",
      schemaVersion: 1,
      eventId: eventId as PairGroupEvent["eventId"],
      groupId: input.group.id as PairGroupId,
      causationId: input.runId,
      occurredAtMs: input.nowMs,
      payload: {
        upHeldShares6: aggregate.upHeldShares6,
        downHeldShares6: aggregate.downHeldShares6,
        reservedCash6: aggregate.reservedCash6,
        cashDebits6: aggregate.cashDebits6,
        cashCredits6: aggregate.cashCredits6,
        currentWorstCaseLoss6: aggregate.currentWorstCaseLoss6,
      },
    };
    const repaired = reducePairGroupOrThrow(aggregate, event);
    const summary: PairGroupReconciliationSummary = {
      reconciliationId: input.runId,
      groupId: input.group.id,
      status: "HEALTHY",
      schedulingAllowed: true,
      projectionRebuilt: true,
      diffCodes: diffs.map(({ code }) => code),
    };
    await this.handle.db.transaction(async (tx) => {
      const current = await tx.select().from(schema.pairOrderGroups)
        .where(eq(schema.pairOrderGroups.id, input.group.id)).limit(1);
      if (current[0]?.stateVersion !== input.group.stateVersion || current[0]?.eventSequence !== input.group.eventSequence) {
        throw new PairStartupReconciliationConcurrentChangeError("pair group changed during startup reconciliation");
      }
      await tx.insert(schema.pairReconciliations).values({
        id: input.runId,
        groupId: input.group.id,
        cause: "STARTUP",
        startedAtMs: input.nowMs,
        completedAtMs: input.nowMs,
        status: "HEALTHY",
        checkedEventSequence: aggregate.eventCount,
        projectionRebuilt: true,
        summary: canonicalJsonValue(summary) as never,
        createdAtMs: input.nowMs,
      });
      await tx.insert(schema.pairGroupEvents).values({
        id: eventId,
        groupId: input.group.id,
        sequence: repaired.eventCount,
        eventType: event.type,
        eventSchemaVersion: event.schemaVersion,
        causationId: event.causationId,
        correlationId: input.runId,
        payload: canonicalJsonValue(event.payload) as never,
        occurredAtMs: input.nowMs,
        recordedAtMs: input.nowMs,
      });
      await tx.update(schema.pairOrderGroups).set(repairPatch(repaired, realizedPnl6, input.nowMs))
        .where(eq(schema.pairOrderGroups.id, input.group.id));
      if (input.reconcileAccountProjection) {
        const updated = await tx.update(schema.pairPaperAccounts)
          .set(accountRepairPatch(accountState, accountGroups, input.nowMs))
          .where(and(
            eq(schema.pairPaperAccounts.id, accountState.account.id),
            eq(schema.pairPaperAccounts.stateVersion, accountState.account.stateVersion),
          )).returning();
        if (updated[0] === undefined) {
          throw new PairStartupReconciliationConcurrentChangeError("pair account changed during startup reconciliation");
        }
      }
      if (diffs.length > 0) {
        await tx.insert(schema.pairReconciliationDiffs).values(diffs.map((item, ordinal) => ({
          id: diffId(input.runId, item, ordinal),
          reconciliationId: input.runId,
          groupId: input.group.id,
          severity: item.severity,
          code: item.code,
          expectedJson: item.expected === null ? null : canonicalJsonValue({ value: item.expected }) as never,
          actualJson: item.actual === null ? null : canonicalJsonValue({ value: item.actual }) as never,
          autoRepairable: item.autoRepairable,
          repairedAtMs: item.autoRepairable ? input.nowMs : null,
          createdAtMs: input.nowMs,
        })));
      }
    });
    return summary;
  }

  private async persistAccountRepair(
    input: { readonly runId: string; readonly group: PairOrderGroupRow; readonly nowMs: number; readonly reconcileAccountProjection: boolean },
    checkedEventSequence: number,
    accountState: PairAccountState,
    accountGroups: readonly PairOrderGroupRow[],
    diffs: readonly PairReconciliationDiff[],
  ): Promise<PairGroupReconciliationSummary> {
    const summary: PairGroupReconciliationSummary = {
      reconciliationId: input.runId,
      groupId: input.group.id,
      status: "HEALTHY",
      schedulingAllowed: true,
      projectionRebuilt: true,
      diffCodes: diffs.map(({ code }) => code),
    };
    await this.handle.db.transaction(async (tx) => {
      await tx.insert(schema.pairReconciliations).values({
        id: input.runId,
        groupId: input.group.id,
        cause: "STARTUP",
        startedAtMs: input.nowMs,
        completedAtMs: input.nowMs,
        status: "HEALTHY",
        checkedEventSequence,
        projectionRebuilt: true,
        summary: canonicalJsonValue(summary) as never,
        createdAtMs: input.nowMs,
      });
      const updated = await tx.update(schema.pairPaperAccounts)
        .set(accountRepairPatch(accountState, accountGroups, input.nowMs))
        .where(and(
          eq(schema.pairPaperAccounts.id, accountState.account.id),
          eq(schema.pairPaperAccounts.stateVersion, accountState.account.stateVersion),
        )).returning();
      if (updated[0] === undefined) {
        throw new PairStartupReconciliationConcurrentChangeError("pair account changed during startup reconciliation");
      }
      await tx.update(schema.pairOrderGroups).set({
        reconciliationStatus: "HEALTHY",
        lastReconciledAtMs: input.nowMs,
        updatedAtMs: input.nowMs,
      }).where(and(
        eq(schema.pairOrderGroups.id, input.group.id),
        eq(schema.pairOrderGroups.stateVersion, input.group.stateVersion),
        eq(schema.pairOrderGroups.eventSequence, input.group.eventSequence),
      ));
      await tx.insert(schema.pairReconciliationDiffs).values(diffs.map((item, ordinal) => ({
        id: diffId(input.runId, item, ordinal),
        reconciliationId: input.runId,
        groupId: input.group.id,
        severity: item.severity,
        code: item.code,
        expectedJson: item.expected === null ? null : canonicalJsonValue({ value: item.expected }) as never,
        actualJson: item.actual === null ? null : canonicalJsonValue({ value: item.actual }) as never,
        autoRepairable: item.autoRepairable,
        repairedAtMs: input.nowMs,
        createdAtMs: input.nowMs,
      })));
    });
    return summary;
  }
}

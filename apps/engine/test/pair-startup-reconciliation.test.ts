import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeDb, schema, type DbHandle } from "@b5p/db";
import { PairAccountStore } from "../src/pair-account-store";
import { PairStore, type PairOrderGroupInsert } from "../src/pair-store";
import { PairStartupReconciler } from "../src/pair-startup-reconciliation";
import { eq } from "drizzle-orm";

const now = 1_800_000_000_000;
let handle: DbHandle;
let pairStore: PairStore;
let reconciler: PairStartupReconciler;

beforeEach(async () => {
  handle = await makeDb({ pgliteDir: "memory://" });
  await handle.migrate();
  pairStore = new PairStore(handle);
  reconciler = new PairStartupReconciler(handle);
  await seedParents();
  await new PairAccountStore(handle).createAccount({
    id: "account",
    sessionKey: "startup-session",
    sourceConfigVersion: 1,
    startingCash6: 100_000_000n,
    dailyBucketUtc: "2027-01-15",
    createdAtMs: now,
  });
  await pairStore.createGroup(group());
  await appendCreated();
});

afterEach(async () => { await handle.close(); });

async function seedParents(): Promise<void> {
  await handle.db.insert(schema.pairBookCaptures).values({
    id: "capture", marketId: "market", conditionId: "condition", captureKind: "SIGNAL",
    capturedAtMs: now, captureSequence: 1n,
    upTokenId: "up", upBookVersion: 1n, upConnectionEpoch: "epoch", upIntegrity: "COMPLETE",
    upReceivedTsMs: now, upLocalHash: "up-hash", upLevelsJson: { bids: [], asks: [] },
    downTokenId: "down", downBookVersion: 1n, downConnectionEpoch: "epoch", downIntegrity: "COMPLETE",
    downReceivedTsMs: now, downLocalHash: "down-hash", downLevelsJson: { bids: [], asks: [] },
    sourceSkewMs: 0, receiveSkewMs: 0,
    upFeeSnapshotId: "fee-up", downFeeSnapshotId: "fee-down",
    upConstraintSnapshotId: "constraint-up", downConstraintSnapshotId: "constraint-down",
    canonicalPayload: {}, captureHash: "capture-hash", createdAtMs: now,
  });
  await handle.db.insert(schema.pairOpportunityObservations).values({
    id: "observation", marketId: "market", conditionId: "condition", strategyVersion: "strategy",
    mode: "paper", observationKind: "NET_ELIGIBLE", triggerKind: "CLOB_ENVELOPE", triggerId: "trigger",
    captureId: "capture", captureHash: "capture-hash", upFeeSnapshotId: "fee-up", downFeeSnapshotId: "fee-down",
    upConstraintSnapshotId: "constraint-up", downConstraintSnapshotId: "constraint-down",
    policyHash: "policy", observerOperationalHash: "ops", configVersion: 1,
    requestedCashCap6: 10_000_000n, rejectionCodes: [], captureSummaryJson: {}, decisionJson: {},
    observedAtMs: now, createdAtMs: now,
  });
  await handle.db.insert(schema.decisionSnapshots).values({
    decisionId: "signal-decision", marketId: "market", mode: "paper", correlationId: "correlation",
    data: { kind: "complete_set_pair_signal_v1" }, createdAtMs: now,
  });
  await handle.db.insert(schema.riskDecisions).values({
    id: "signal-risk", decisionId: "signal-decision", approved: true, reasons: [], capChain: {}, createdAtMs: now,
  });
}

function group(): PairOrderGroupInsert {
  return {
    id: "group", observationId: "observation", pairAccountId: "account",
    signalDecisionId: "signal-decision", signalRiskDecisionId: "signal-risk",
    marketId: "market", conditionId: "condition", strategyVersion: "strategy",
    mode: "paper", route: "PAPER", dispatchModel: "PARALLEL", settlementPolicy: "MERGE_OR_RESOLVE",
    recoveryPolicy: "MINIMIZE_WORST_LOSS", idempotencyKey: "group-idem", requestHash: "group-hash",
    signalCaptureId: "capture", state: "SCHEDULED", stateVersion: 0, eventSequence: 0,
    targetGrossShares6: 1_000_000n, approvedCashCap6: 1_000_000n,
    approvedResidualLoss6: 500_000n, reservedCash6: 0n,
    signalNetPnl6: 10_000n, stressResultsJson: {}, activateAtMs: now,
    nextActionAtMs: now + 100, reconciliationStatus: "NOT_STARTED", createdAtMs: now, updatedAtMs: now,
  };
}

async function appendCreated(): Promise<void> {
  const result = await pairStore.appendEvent({
    groupId: "group",
    expectedStateVersion: 0,
    expectedEventSequence: 0,
    event: {
      id: "event-created", eventType: "PAIR_GROUP_CREATED", eventSchemaVersion: 1,
      causationId: "create", correlationId: "correlation",
      payload: {
        dispatchModel: "PARALLEL", upLegId: "leg-up", downLegId: "leg-down",
        targetGrossShares6: 1_000_000n, approvedCashCap6: 1_000_000n,
        approvedResidualLoss6: 500_000n,
      },
      occurredAtMs: now, recordedAtMs: now,
    },
    projection: { state: "SCHEDULED" },
  });
  expect(result.kind).toBe("APPLIED");
}

async function appendHalt(): Promise<void> {
  const result = await pairStore.appendEvent({
    groupId: "group",
    expectedStateVersion: 1,
    expectedEventSequence: 1,
    event: {
      id: "event-halt", eventType: "PAIR_HALTED", eventSchemaVersion: 1,
      causationId: "halt", correlationId: "correlation", payload: { reason: "startup fixture" },
      occurredAtMs: now + 1, recordedAtMs: now + 1,
    },
    projection: {
      state: "RECONCILING", haltedAtMs: now + 1, haltReason: "startup fixture",
      reconciliationStatus: "PENDING",
    },
  });
  expect(result.kind).toBe("APPLIED");
}

async function seedClaimedEffect(): Promise<void> {
  await handle.db.insert(schema.decisionSnapshots).values({
    decisionId: "action-decision", marketId: "market", mode: "paper", correlationId: "correlation",
    data: { kind: "complete_set_pair_activation_v1" }, createdAtMs: now,
  });
  await handle.db.insert(schema.riskDecisions).values({
    id: "action-risk", decisionId: "action-decision", approved: true, reasons: [], capChain: {}, createdAtMs: now,
  });
  await handle.db.insert(schema.pairActionIntents).values({
    id: "action", groupId: "group", actionSequence: 1, actionKind: "INITIAL_PARALLEL",
    decisionId: "action-decision", riskDecisionId: "action-risk", createdAtMs: now,
  });
  await handle.db.insert(schema.pairEffectOutbox).values({
    id: "effect", groupId: "group", actionIntentId: "action", actionKind: "INITIAL_BUY_UP",
    actionSequence: 1, effectOrdinal: 0, idempotencyKey: "effect-idem", clientOperationId: "client-effect",
    requestHash: "request-hash", requestPayload: { outcome: "UP" }, state: "CLAIMED",
    notBeforeMs: now, deadlineMs: now + 10_000, claimToken: "dead-worker", claimedAtMs: now,
    claimExpiresAtMs: now + 100, attemptCount: 1, createdAtMs: now, updatedAtMs: now,
  });
}

async function createStandaloneAccount(id: string): Promise<void> {
  await new PairAccountStore(handle).createAccount({
    id,
    sessionKey: `session-${id}`,
    sourceConfigVersion: 1,
    startingCash6: 50_000_000n,
    dailyBucketUtc: "2027-01-15",
    createdAtMs: now + 1,
  });
}

describe("pair startup reconciliation gate", () => {
  it("publishes healthy only after durable audit and idempotently repairs the account projection", async () => {
    const first = await reconciler.reconcileStartup({ runKey: "boot-1", nowMs: now + 10 });
    expect(first).toMatchObject({ status: "HEALTHY", observerAllowed: true, paperSchedulingAllowed: true });
    expect(first.groups[0]).toMatchObject({ status: "HEALTHY", projectionRebuilt: true });

    const second = await reconciler.reconcileStartup({ runKey: "boot-1", nowMs: now + 20 });
    expect(second).toEqual(first);
    expect(await handle.db.select().from(schema.pairReconciliations)).toHaveLength(1);
    expect(await handle.db.select().from(schema.pairReconciliationDiffs)).toMatchObject([
      { code: "ACCOUNT_ACTIVE_GROUP_COUNT_MISMATCH", autoRepairable: true, repairedAtMs: now + 10 },
    ]);
    expect((await handle.db.select().from(schema.pairPaperAccounts))[0]).toMatchObject({
      activeGroupCount: 1, reconciliationStatus: "HEALTHY",
    });
  });

  it("repairs projection-only drift with one explicit immutable rebuild event", async () => {
    await appendHalt();
    await handle.db.update(schema.pairOrderGroups).set({ matchedShares6: 9n, residualShares6: 7n });

    const result = await reconciler.reconcileStartup({ runKey: "boot-repair", nowMs: now + 20 });
    expect(result).toMatchObject({ status: "HEALTHY", paperSchedulingAllowed: true });
    expect(result.groups[0]).toMatchObject({ projectionRebuilt: true, status: "HEALTHY" });
    expect(result.groups[0]!.diffCodes).toEqual(expect.arrayContaining([
      "PROJECTION_MATCHED_MISMATCH", "PROJECTION_RESIDUAL_MISMATCH",
    ]));
    expect(await pairStore.listEvents("group")).toMatchObject([
      { eventType: "PAIR_GROUP_CREATED" },
      { eventType: "PAIR_HALTED" },
      { eventType: "PAIR_PROJECTION_REBUILT" },
    ]);
    expect(await pairStore.getGroup("group")).toMatchObject({
      state: "RECONCILING", stateVersion: 3, eventSequence: 3,
      matchedShares6: 0n, residualShares6: 0n, reconciliationStatus: "HEALTHY",
    });
    const repeated = await reconciler.reconcileStartup({ runKey: "boot-repair", nowMs: now + 30 });
    expect(repeated).toEqual(result);
    expect(await pairStore.listEvents("group")).toHaveLength(3);
    const rows = await handle.db.select().from(schema.pairReconciliationDiffs);
    expect(rows.filter(({ code }) => code.startsWith("PROJECTION_"))).toSatisfy((items: typeof rows) =>
      items.length === 2 && items.every(({ repairedAtMs }) => repairedAtMs === now + 20));
  });

  it("retains claimed/unknown state, performs no effect, and blocks paper scheduling", async () => {
    await seedClaimedEffect();
    const before = await handle.db.select().from(schema.pairEffectOutbox);

    const result = await reconciler.reconcileStartup({ runKey: "boot-unknown", nowMs: now + 200 });
    expect(result).toMatchObject({ status: "BLOCKED", observerAllowed: true, paperSchedulingAllowed: false });
    expect(result.groups[0]).toMatchObject({ status: "PENDING_OBSERVATION", schedulingAllowed: false });
    expect(result.groups[0]!.diffCodes).toContain("UNKNOWN_EFFECT_REQUIRES_OBSERVATION");
    expect(await handle.db.select().from(schema.pairEffectOutbox)).toEqual(before);
    expect(await handle.db.select().from(schema.pairPaperVenueOperations)).toHaveLength(0);
    expect(await pairStore.getGroup("group")).toMatchObject({ state: "SCHEDULED", reservedCash6: 0n });
  });

  it("persists event gaps as manual-review diffs and fails closed without guessing state", async () => {
    await handle.db.update(schema.pairGroupEvents).set({ sequence: 2 });
    const before = await pairStore.getGroup("group");

    const result = await reconciler.reconcileStartup({ runKey: "boot-gap", nowMs: now + 20 });
    expect(result).toMatchObject({ status: "BLOCKED", paperSchedulingAllowed: false });
    expect(result.groups[0]).toMatchObject({ status: "MANUAL_REVIEW", projectionRebuilt: false });
    expect(result.groups[0]!.diffCodes).toContain("EVENT_SEQUENCE_GAP");
    expect(await pairStore.getGroup("group")).toMatchObject({
      state: before!.state, stateVersion: before!.stateVersion, eventSequence: before!.eventSequence,
      reconciliationStatus: "MISMATCH",
    });
    const diffs = await handle.db.select().from(schema.pairReconciliationDiffs);
    expect(diffs.find(({ code }) => code === "EVENT_SEQUENCE_GAP")).toMatchObject({
      autoRepairable: false, repairedAtMs: null,
    });
  });

  it("treats immutable ledger imbalance as critical and never edits or compensates it", async () => {
    await handle.db.insert(schema.pairLedgerEntries).values({
      id: "corrupt-entry", pairAccountId: "account", groupId: "group", journalId: "corrupt-journal",
      eventId: "event-created", lineNumber: 0, account: "ASSET_CASH_AVAILABLE", assetId: "USDC",
      amount6: 1n, metadata: {}, occurredAtMs: now + 2, recordedAtMs: now + 2,
    });
    const before = await handle.db.select().from(schema.pairLedgerEntries);

    const result = await reconciler.reconcileStartup({ runKey: "boot-ledger", nowMs: now + 20 });
    expect(result).toMatchObject({ status: "BLOCKED", paperSchedulingAllowed: false, observerAllowed: true });
    expect(result.groups[0]).toMatchObject({ status: "MANUAL_REVIEW", schedulingAllowed: false });
    expect(result.groups[0]!.diffCodes).toContain("UNBALANCED_LEDGER_JOURNAL");
    expect(await handle.db.select().from(schema.pairLedgerEntries)).toEqual(before);
    expect(await handle.db.select().from(schema.pairEffectOutbox)).toHaveLength(0);
  });

  it("audits a healthy zero-group account and permits scheduling only after committing health", async () => {
    await createStandaloneAccount("empty-account");

    const result = await reconciler.reconcileStartup({ runKey: "boot-empty-healthy", nowMs: now + 20 });
    expect(result).toMatchObject({ status: "HEALTHY", paperSchedulingAllowed: true });
    expect(result.accounts).toEqual([{
      reconciliationId: expect.stringMatching(/^pair-account-recon-/),
      accountId: "empty-account",
      groupId: null,
      status: "HEALTHY",
      schedulingAllowed: true,
      diffs: [],
    }]);
    expect((await handle.db.select().from(schema.pairPaperAccounts))
      .find(({ id }) => id === "empty-account")).toMatchObject({
        reconciliationStatus: "HEALTHY", lastReconciledAtMs: now + 20,
      });
    const audit = (await handle.db.select().from(schema.pairReconciliations))
      .find(({ groupId }) => groupId === null);
    expect(audit).toMatchObject({ cause: "STARTUP_ACCOUNT_ONLY", status: "HEALTHY", groupId: null });
  });

  it("blocks a drifted zero-group account and retains exact diffs in its nullable-group audit summary", async () => {
    await createStandaloneAccount("drifted-account");
    await handle.db.update(schema.pairPaperAccounts).set({ cashAvailable6: 49_999_999n })
      .where(eq(schema.pairPaperAccounts.id, "drifted-account"));

    const result = await reconciler.reconcileStartup({ runKey: "boot-empty-drift", nowMs: now + 20 });
    expect(result).toMatchObject({ status: "BLOCKED", paperSchedulingAllowed: false, observerAllowed: true });
    expect(result.accounts[0]).toMatchObject({
      accountId: "drifted-account", groupId: null, status: "MANUAL_REVIEW", schedulingAllowed: false,
      diffs: [{ code: "ACCOUNT_CASH_AVAILABLE_MISMATCH", expected: "50000000", actual: "49999999" }],
    });
    const audit = (await handle.db.select().from(schema.pairReconciliations))
      .find(({ groupId }) => groupId === null);
    expect(audit?.summary).toMatchObject({
      accountId: "drifted-account",
      diffs: [{ code: "ACCOUNT_CASH_AVAILABLE_MISMATCH", expected: "50000000", actual: "49999999" }],
    });
    expect(await handle.db.select().from(schema.pairReconciliationDiffs)).not.toContainEqual(
      expect.objectContaining({ groupId: null }),
    );
    expect((await handle.db.select().from(schema.pairPaperAccounts))
      .find(({ id }) => id === "drifted-account")).toMatchObject({
        cashAvailable6: 49_999_999n, reconciliationStatus: "MISMATCH",
      });
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeDb, schema, type DbHandle } from "@b5p/db";
import { canonicalObjectHash } from "@b5p/pair-execution";
import { PairStore, PairStoreIdempotencyCollisionError, type PairOrderGroupInsert } from "../src/pair-store";
import { MarketExposureGuardStore } from "../src/market-exposure-guard-store";

const now = 1_800_000_000_000;
let handle: DbHandle;
let store: PairStore;

beforeEach(async () => {
  handle = await makeDb({ pgliteDir: "memory://" });
  await handle.migrate();
  store = new PairStore(handle);
  await seedParents();
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
  await handle.db.insert(schema.pairPaperAccounts).values({
    id: "account", accountModel: "ISOLATED_PAIR_PAPER", sessionKey: "session", sourceConfigVersion: 1,
    startingCash6: 100_000_000n, cashAvailable6: 100_000_000n, peakCash6: 100_000_000n,
    dailyBucketUtc: "2027-01-15", reconciliationStatus: "NOT_STARTED", createdAtMs: now, updatedAtMs: now,
  });
  await handle.db.insert(schema.decisionSnapshots).values({
    decisionId: "signal-decision", marketId: "market", mode: "paper", correlationId: "correlation",
    data: { kind: "complete_set_pair_signal_v1" }, createdAtMs: now,
  });
  await handle.db.insert(schema.riskDecisions).values({
    id: "signal-risk", decisionId: "signal-decision", approved: true, reasons: [], capChain: {}, createdAtMs: now,
  });
}

function group(id = "group", marketId = "market", idempotencyKey = `idem-${id}`): PairOrderGroupInsert {
  return {
    id, observationId: "observation", pairAccountId: "account", signalDecisionId: "signal-decision",
    signalRiskDecisionId: "signal-risk", marketId, conditionId: "condition", strategyVersion: "strategy",
    mode: "paper", route: "PAPER", dispatchModel: "PARALLEL", settlementPolicy: "MERGE_OR_RESOLVE",
    recoveryPolicy: "MINIMIZE_WORST_LOSS", idempotencyKey, requestHash: `hash-${id}`,
    signalCaptureId: "capture", state: "SCHEDULED", stateVersion: 0, eventSequence: 0,
    targetGrossShares6: 1_000_000n, approvedCashCap6: 1_000_000n,
    approvedResidualLoss6: 500_000n, reservedCash6: 1_000_000n,
    signalNetPnl6: 10_000n, stressResultsJson: {}, activateAtMs: now,
    nextActionAtMs: now + 100, reconciliationStatus: "NOT_STARTED", createdAtMs: now, updatedAtMs: now,
  };
}

function event(causationId = "cause", id = "event") {
  return {
    id, eventType: "PAIR_ACTIVATION_STARTED", eventSchemaVersion: 1,
    causationId, correlationId: "correlation", payload: { exact: 1n },
    occurredAtMs: now + 100, recordedAtMs: now + 100,
  };
}

async function seedAction(): Promise<void> {
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
}

function effect(id = "effect") {
  return {
    id, actionIntentId: "action", actionKind: "INITIAL_BUY_UP", actionSequence: 1, effectOrdinal: 0,
    idempotencyKey: `idem-${id}`, clientOperationId: `client-${id}`, requestHash: `request-${id}`,
    requestPayload: { outcome: "UP", shares6: 1_000_000n }, notBeforeMs: now + 100,
    deadlineMs: now + 1_000, createdAtMs: now + 100,
  };
}

describe("durable pair store", () => {
  it("uses event/projection CAS and treats exact causation redelivery idempotently", async () => {
    expect((await store.createGroup(group())).kind).toBe("CREATED");
    const input = { groupId: "group", expectedStateVersion: 0, expectedEventSequence: 0, event: event(), projection: { state: "ACTIVATING" } };
    const [a, b] = await Promise.all([store.appendEvent(input), store.appendEvent({ ...input, event: event("cause-2", "event-2") })]);
    expect([a.kind, b.kind].sort()).toEqual(["APPLIED", "CONFLICT"]);
    expect(await store.listEvents("group")).toHaveLength(1);

    const committed = (await store.listEvents("group"))[0]!;
    const duplicate = await store.appendEvent({ ...input, event: event(committed.causationId, committed.id) });
    expect(duplicate).toMatchObject({ kind: "DUPLICATE", stateVersion: 1, eventSequence: 1 });
    await expect(store.appendEvent({ ...input, event: { ...event(committed.causationId, committed.id), payload: { exact: 2n } } }))
      .rejects.toBeInstanceOf(PairStoreIdempotencyCollisionError);
  });

  it("enforces one active group per market while allowing terminal history", async () => {
    expect((await store.createGroup(group())).kind).toBe("CREATED");
    expect(await store.findDueGroups(now + 99)).toHaveLength(0);
    expect(await store.findDueGroups(now + 100)).toMatchObject([{ id: "group" }]);
    const blocked = await store.createGroup(group("group-2", "market"));
    expect(blocked).toMatchObject({ kind: "ACTIVE_MARKET_CONFLICT", active: { id: "group" } });
    await handle.db.update(schema.pairOrderGroups).set({ state: "RECONCILED_FLAT" });
    expect((await store.createGroup(group("group-2", "market"))).kind).toBe("CREATED");
  });

  it("acquires the shared guard in the group transaction and loses to active directional exposure", async () => {
    const directional = await new MarketExposureGuardStore(handle).acquire({
      marketId: "market", ownerKind: "DIRECTIONAL_ORDER", ownerId: "directional-order",
      ownerState: "PENDING", acquiredAtMs: now,
    });
    expect(directional.kind).toBe("ACQUIRED");
    expect(await store.createGroup(group())).toEqual({
      kind: "MARKET_EXPOSURE_CONFLICT", code: "MARKET_ACTIVE",
      ownerKind: "DIRECTIONAL_ORDER", ownerId: "directional-order",
    });
    expect(await handle.db.select().from(schema.pairOrderGroups)).toHaveLength(0);
  });

  it("commits event, projection, and effect together and rolls all three back on outbox failure", async () => {
    await store.createGroup(group());
    await seedAction();
    const applied = await store.appendEvent({
      groupId: "group", expectedStateVersion: 0, expectedEventSequence: 0, event: event(),
      projection: { state: "SUBMITTING", nextActionAtMs: null }, effects: [effect()],
    });
    expect(applied.kind).toBe("APPLIED");
    // This query represents the first line of an adapter call: every causal row is already committed.
    expect(await handle.db.select().from(schema.pairEffectOutbox)).toMatchObject([{ id: "effect", state: "PENDING", requestHash: "request-effect" }]);
    expect(await store.getGroup("group")).toMatchObject({ state: "SUBMITTING", stateVersion: 1, eventSequence: 1 });
    expect(await store.listEvents("group")).toHaveLength(1);

    await expect(store.appendEvent({
      groupId: "group", expectedStateVersion: 1, expectedEventSequence: 1, event: event("cause-bad", "event-bad"),
      projection: { state: "OUTCOME_UNKNOWN" }, effects: [{ ...effect("bad"), actionIntentId: "missing", effectOrdinal: 1 }],
    })).rejects.toThrow();
    expect(await store.getGroup("group")).toMatchObject({ state: "SUBMITTING", stateVersion: 1, eventSequence: 1 });
    expect(await store.listEvents("group")).toHaveLength(1);
  });

  it("claims a due effect once and detects evidence hash collisions", async () => {
    await store.createGroup(group());
    await seedAction();
    await store.appendEvent({
      groupId: "group", expectedStateVersion: 0, expectedEventSequence: 0, event: event(),
      projection: { state: "SUBMITTING" }, effects: [effect()],
    });
    expect(await store.findDueEffects(now + 99)).toHaveLength(0);
    const [a, b] = await Promise.all([
      store.claimNextDueEffect({ nowMs: now + 100, leaseMs: 1_000, claimToken: "worker-a" }),
      store.claimNextDueEffect({ nowMs: now + 100, leaseMs: 1_000, claimToken: "worker-b" }),
    ]);
    expect([a, b].filter((x) => x !== null)).toHaveLength(1);
    expect((a ?? b)).toMatchObject({ id: "effect", state: "CLAIMED", attemptCount: 1 });

    const payload = { kind: "FILLED", grossShares6: 1_000_000n };
    const evidence = { id: "evidence", groupId: "group", effectId: "effect", evidenceKey: "provider:result",
      evidenceKind: "PAPER_RESULT", payloadHash: canonicalObjectHash(payload), payload,
      receivedTsMs: now + 200, createdAtMs: now + 200, effectTerminalState: "SUCCEEDED" as const };
    expect((await store.ingestEvidence(evidence)).kind).toBe("INSERTED");
    expect((await store.ingestEvidence(evidence)).kind).toBe("DUPLICATE");
    expect((await handle.db.select().from(schema.pairEffectOutbox))[0]).toMatchObject({ state: "SUCCEEDED", resultEvidenceId: "evidence" });

    const collisionPayload = { kind: "NO_FILL" };
    await expect(store.ingestEvidence({ ...evidence, id: "other", payload: collisionPayload, payloadHash: canonicalObjectHash(collisionPayload) }))
      .rejects.toBeInstanceOf(PairStoreIdempotencyCollisionError);
  });
});

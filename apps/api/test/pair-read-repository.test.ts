import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, schema, type DbHandle } from "@b5p/db";
import Fastify from "fastify";
import {
  PairReadModelRepository,
  PairReadModelValidationError,
} from "../src/pair-read-repository";
import { registerPairReadRoutes } from "../src/pair-routes";

const now = 1_800_000_000_000;
const unsafeExact = 9_007_199_254_740_993n;
let handle: DbHandle;
let repository: PairReadModelRepository;
const queries: string[] = [];

beforeAll(async () => {
  handle = await makeDb({ pgliteDir: "memory://" });
  await handle.migrate();
  await seed();
  repository = new PairReadModelRepository(handle, {
    capability: {
      observerEnabled: true,
      paperExecutionEnabled: true,
      liveExecutionAvailable: false,
      strategyVersion: "strategy-v1",
    },
    runtimeHealth: () => ({ feedIntegrity: "HEALTHY", exactLagCount: 9_000_000_000_000_000_000n }),
    onQuery: (name) => queries.push(name),
  });
});

beforeEach(() => { queries.length = 0; });
afterAll(async () => { await handle.close(); });

async function seed(): Promise<void> {
  await handle.db.insert(schema.pairOpportunityEpisodes).values([
    { id: "episode-a", marketId: "market-a", strategyVersion: "strategy-v1", state: "CLOSED", firstObservedAtMs: now - 300, lastObservedAtMs: now - 250, closedAtMs: now - 200, closeReason: "COOLED", minimumAskSum6: 990_000n, maximumSignalNetPnl6: 1n, envelopeCount: 2n, eligibleEnvelopeCount: 1n, createdAtMs: now - 300, updatedAtMs: now - 200 },
    { id: "episode-b", marketId: "market-b", strategyVersion: "strategy-v1", state: "OPEN", firstObservedAtMs: now - 100, lastObservedAtMs: now - 50, minimumAskSum6: 980_000n, maximumSignalNetPnl6: 2n, envelopeCount: 3n, eligibleEnvelopeCount: 2n, createdAtMs: now - 100, updatedAtMs: now - 50 },
    { id: "episode-c", marketId: "market-c", strategyVersion: "strategy-v1", state: "OPEN", firstObservedAtMs: now - 100, lastObservedAtMs: now - 40, minimumAskSum6: 970_000n, maximumSignalNetPnl6: 3n, envelopeCount: 4n, eligibleEnvelopeCount: 3n, createdAtMs: now - 100, updatedAtMs: now - 40 },
  ]);

  await handle.db.insert(schema.pairBookCaptures).values(["a", "b", "c"].map((suffix, index) => ({
    id: `capture-${suffix}`, marketId: `market-${suffix}`, conditionId: `condition-${suffix}`, captureKind: "SIGNAL",
    capturedAtMs: now - 300 + index * 100, captureSequence: BigInt(index + 1),
    upTokenId: `up-${suffix}`, upBookVersion: 1n, upConnectionEpoch: "epoch", upIntegrity: "COMPLETE",
    upReceivedTsMs: now, upLocalHash: `up-hash-${suffix}`, upLevelsJson: { bids: [], asks: [] },
    downTokenId: `down-${suffix}`, downBookVersion: 1n, downConnectionEpoch: "epoch", downIntegrity: "COMPLETE",
    downReceivedTsMs: now, downLocalHash: `down-hash-${suffix}`, downLevelsJson: { bids: [], asks: [] },
    sourceSkewMs: 0, receiveSkewMs: 0, upFeeSnapshotId: `fee-up-${suffix}`, downFeeSnapshotId: `fee-down-${suffix}`,
    upConstraintSnapshotId: `constraint-up-${suffix}`, downConstraintSnapshotId: `constraint-down-${suffix}`,
    canonicalPayload: {}, captureHash: `capture-hash-${suffix}`, createdAtMs: now,
  })));

  await handle.db.insert(schema.pairOpportunityObservations).values(["a", "b", "c"].map((suffix, index) => ({
    id: `observation-${suffix}`, episodeId: `episode-${suffix}`, marketId: `market-${suffix}`, conditionId: `condition-${suffix}`,
    strategyVersion: "strategy-v1", mode: "paper", observationKind: index === 0 ? "REJECTED" : "NET_ELIGIBLE",
    triggerKind: "CLOB_ENVELOPE", triggerId: `trigger-${suffix}`, captureId: `capture-${suffix}`, captureHash: `capture-hash-${suffix}`,
    upFeeSnapshotId: `fee-up-${suffix}`, downFeeSnapshotId: `fee-down-${suffix}`,
    upConstraintSnapshotId: `constraint-up-${suffix}`, downConstraintSnapshotId: `constraint-down-${suffix}`,
    policyHash: "policy", observerOperationalHash: "operational", configVersion: 1, requestedCashCap6: 9_000_000_000_000_000_000n,
    selectedPairShares6: BigInt(index + 1) * 1_000_000n, grossTopOfBookEdge6: BigInt(index + 10),
    netPreLatencyPnl6: BigInt(index - 1), primaryRejectionCode: index === 0 ? "NET_PNL_BELOW_MINIMUM" : null,
    rejectionCodes: index === 0 ? ["NET_PNL_BELOW_MINIMUM"] : [], captureSummaryJson: {}, quoteJson: { exact: "1" }, decisionJson: {},
    observedAtMs: index === 0 ? now - 300 : now - 100, createdAtMs: now,
  })));

  await handle.db.insert(schema.pairPaperAccounts).values({
    id: "account", accountModel: "ISOLATED_PAIR_PAPER", sessionKey: "session", sourceConfigVersion: 1,
    startingCash6: 9_000_000_000_000_000_000n, cashAvailable6: 9_000_000_000_000_000_000n,
    cashReserved6: 200n, peakCash6: 9_000_000_000_000_000_000n, dailyBucketUtc: "2027-01-15",
    reconciliationStatus: "HEALTHY", lastReconciledAtMs: now - 10, createdAtMs: now - 1_000, updatedAtMs: now,
  });
  await handle.db.insert(schema.decisionSnapshots).values(["a", "b", "c", "action"].map((suffix) => ({
    decisionId: `decision-${suffix}`, marketId: suffix === "action" ? "market-a" : `market-${suffix}`, mode: "paper",
    correlationId: `correlation-${suffix}`, data: suffix === "action"
      ? { kind: "pair_activation", quote: { upCost6: "440000", downCost6: "450000", activationNetPnl6: "110000" } }
      : { kind: "pair_signal", quote: { upCost6: "430000", downCost6: "450000", signalNetPnl6: "120000" } }, createdAtMs: now,
  })));
  await handle.db.insert(schema.riskDecisions).values(["a", "b", "c", "action"].map((suffix) => ({
    id: `risk-${suffix}`, decisionId: `decision-${suffix}`, approved: true,
    reasons: suffix === "action" ? [{ code: "ALL_GATES_PASSED", message: "activation risk gates passed" }] : [],
    capChain: { cashCap6: unsafeExact.toString(), residualLossCap6: "100000" }, createdAtMs: now,
  })));
  await handle.db.insert(schema.orderIntents).values({
    id: "order-intent-action", decisionId: "decision-action", version: 1, idempotencyKey: "order-intent-action-idem",
    payload: { route: "DIRECT_BUY_BOTH", targetGrossShares6: unsafeExact.toString() }, createdAtMs: now - 291,
  });
  await handle.db.insert(schema.pairOrderGroups).values([
    group("a", "RECONCILED_SETTLED", now - 300, { realizedPairPnl6: 1_000n, closedAtMs: now - 200, reconciliationStatus: "HEALTHY" }),
    group("b", "RESIDUAL", now - 100, { residualSide: "UP", residualShares6: 500_000n, realizedPairPnl6: -200n }),
    group("c", "OUTCOME_UNKNOWN", now - 100, { realizedPairPnl6: -100n }),
  ]);

  await handle.db.insert(schema.pairGroupEvents).values([
    { id: "event-a1", groupId: "group-a", sequence: 1, eventType: "PAIR_GROUP_CREATED", eventSchemaVersion: 1, causationId: "cause-a1", correlationId: "correlation-a", payload: { amount6: "1000000" }, occurredAtMs: now - 300, recordedAtMs: now - 300 },
    { id: "event-a2", groupId: "group-a", sequence: 2, eventType: "PAIR_GROUP_CLOSED", eventSchemaVersion: 1, causationId: "cause-a2", correlationId: "correlation-a", payload: {}, occurredAtMs: now - 200, recordedAtMs: now - 200 },
  ]);
  await handle.db.insert(schema.pairActionIntents).values({
    id: "action-a", groupId: "group-a", actionSequence: 1, actionKind: "INITIAL_PARALLEL",
    captureId: "capture-a", decisionId: "decision-action", riskDecisionId: "risk-action", orderIntentId: "order-intent-action", createdAtMs: now - 290,
  });
  await handle.db.insert(schema.pairEffectOutbox).values({
    id: "effect-a", groupId: "group-a", actionIntentId: "action-a", actionKind: "INITIAL_BUY_UP", actionSequence: 1,
    effectOrdinal: 0, idempotencyKey: "effect-idem-a", clientOperationId: "client-a", requestHash: "request-a",
    requestPayload: { shares6: "1000000" }, state: "SUCCEEDED", notBeforeMs: now - 280, deadlineMs: now - 200,
    createdAtMs: now - 280, updatedAtMs: now - 200,
  });
  await handle.db.insert(schema.orders).values([
    {
      id: "order-a-up", intentId: "order-intent-action", decisionId: "decision-action", marketId: "market-a", tokenId: "up-a",
      outcomeSide: "UP", orderSide: "BUY", style: "taker_fok", timeInForce: "FOK", postOnly: false,
      price6: 490_000n, shares6: unsafeExact, filledShares6: unsafeExact, stake6: unsafeExact, mode: "paper", status: "MATCHED",
      createdAtMs: now - 270, updatedAtMs: now - 250, pairGroupId: "group-a", pairLegId: "up-leg-a",
      pairAction: "INITIAL_BUY_UP", clientOrderId: "client-order-a-up", effectId: "effect-a", requestHash: "request-a",
    },
    {
      id: "order-a-down", intentId: "order-intent-action", decisionId: "decision-action", marketId: "market-a", tokenId: "down-a",
      outcomeSide: "DOWN", orderSide: "BUY", style: "taker_fok", timeInForce: "FOK", postOnly: false,
      price6: 500_000n, shares6: 2_000_000n, filledShares6: 2_000_000n, stake6: 1_000_000n, mode: "paper", status: "MATCHED",
      createdAtMs: now - 269, updatedAtMs: now - 249, pairGroupId: "group-a", pairLegId: "down-leg-a",
      pairAction: "INITIAL_BUY_DOWN", clientOrderId: "client-order-a-down", requestHash: "request-down-a",
    },
  ]);
  await handle.db.insert(schema.orderFills).values([
    { id: "fill-a", orderId: "order-a-up", price6: 490_000n, shares6: unsafeExact - 1n, feeUsdc6: 7n, maker: false, tradeRef: "trade-a-1", tsMs: now - 260, feeConvention: "usdc", feeShares6: 0n, netShares6: unsafeExact - 1n, sourceEvidenceId: "evidence-a", receivedAtMs: now - 259 },
    { id: "fill-a-level-2", orderId: "order-a-up", price6: 491_000n, shares6: 1n, feeUsdc6: 1n, maker: false, tradeRef: "trade-a-2", tsMs: now - 259, feeConvention: "usdc", feeShares6: 0n, netShares6: 1n, sourceEvidenceId: "evidence-a", receivedAtMs: now - 258 },
    { id: "fill-a-down", orderId: "order-a-down", price6: 500_000n, shares6: 2_000_000n, feeUsdc6: 3n, maker: false, tradeRef: "trade-a-3", tsMs: now - 258, feeConvention: "usdc", feeShares6: 0n, netShares6: 2_000_000n, sourceEvidenceId: "evidence-a", receivedAtMs: now - 257 },
  ]);
  await handle.db.insert(schema.pairInventoryLots).values({
    id: "lot-a", groupId: "group-a", marketId: "market-a", tokenId: "up-a", outcome: "UP", sourceFillId: "fill-a",
    grossShares6: 1_000_000n, netShares6: 1_000_000n, principalCost6: 400_000n, cashFee6: 0n, shareFee6: 0n,
    acquiredAtMs: now - 250, createdAtMs: now - 250,
  });
  await handle.db.insert(schema.pairLedgerEntries).values({
    id: "ledger-a", pairAccountId: "account", groupId: "group-a", journalId: "journal-a", eventId: "event-a1", lineNumber: 0,
    account: "ASSET_CASH_AVAILABLE", assetId: "USDC", amount6: 1_000n, metadata: {}, occurredAtMs: now - 200, recordedAtMs: now - 200,
  });
  await handle.db.insert(schema.pairInboxEvidence).values({
    id: "evidence-a", groupId: "group-a", effectId: "effect-a", evidenceKey: "paper:a", evidenceKind: "PAPER_RESULT",
    payloadHash: "payload-a", payload: { filledShares6: "1000000" }, receivedTsMs: now - 220, processedAtMs: now - 210,
    processingResult: "APPLIED", createdAtMs: now - 220,
  });

  await handle.db.insert(schema.pairReconciliations).values([
    { id: "reconciliation-a1", groupId: "group-a", cause: "STARTUP", startedAtMs: now - 150, completedAtMs: now - 140, status: "HEALTHY", checkedEventSequence: 2, summary: {}, createdAtMs: now - 150 },
    { id: "reconciliation-a2", groupId: "group-a", cause: "PERIODIC", startedAtMs: now - 50, completedAtMs: now - 40, status: "MANUAL_REVIEW", checkedEventSequence: 2, summary: {}, createdAtMs: now - 50 },
  ]);
  await handle.db.insert(schema.pairReconciliationDiffs).values([
    { id: "diff-a1", reconciliationId: "reconciliation-a1", groupId: "group-a", severity: "DIAGNOSTIC", code: "OK_AUDIT", autoRepairable: false, createdAtMs: now - 140 },
    { id: "diff-a2", reconciliationId: "reconciliation-a2", groupId: "group-a", severity: "CRITICAL", code: "MISSING_FILL", autoRepairable: false, createdAtMs: now - 40 },
  ]);

  await handle.db.insert(schema.pairObserverBucketStats).values({
    bucketStartMs: now - 60_000, bucketWidthMs: 60_000, strategyVersion: "strategy-v1", policyHash: "policy", marketId: "market-a",
    evaluatedCaptures: 10n, grossDislocations: 4n, feePositive: 3n, rejectionCountsJson: {}, updatedAtMs: now,
  });

  await handle.db.insert(schema.pairResearchRuns).values(["a", "b", "c"].map((suffix, index) => ({
    id: `run-${suffix}`, status: index === 2 ? "FAILED" : "SUCCEEDED", datasetManifestVersion: 1, datasetManifestJson: {}, datasetHash: `dataset-${suffix}`,
    codeCommit: "commit", strategyVersion: "strategy-v1", baseConfigJson: {}, basePolicyHash: "policy", observerOperationalHash: "operational",
    scenarioMatrixJson: {}, scenarioMatrixHash: `matrix-${suffix}`, seedAlgorithm: "pcg32", seedText: "seed", fromMs: now - 1_000, toMs: now,
    marketCount: index + 1, eventCount: 9_000_000_000_000_000_000n + BigInt(index), episodeCount: index + 2,
    startedAtMs: index === 0 ? now - 300 : now - 100, createdAtMs: now,
  })));
  await handle.db.insert(schema.pairResearchScenarios).values({
    id: "scenario-a", runId: "run-a", scenarioHash: "scenario-hash", scenarioJson: {}, status: "SUCCEEDED",
    startedAtMs: now - 290,
  });
  await handle.db.insert(schema.pairResearchArtifacts).values({
    id: "artifact-a", runId: "run-a", artifactKind: "REPORT_JSON", relativePath: "run-a/report.json", mimeType: "application/json",
    sha256: "sha", byteSize: 123, createdAtMs: now,
  });
}

function group(suffix: string, state: string, createdAtMs: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `group-${suffix}`, observationId: `observation-${suffix}`, episodeId: `episode-${suffix}`, pairAccountId: "account",
    signalDecisionId: `decision-${suffix}`, signalRiskDecisionId: `risk-${suffix}`, marketId: `market-${suffix}`,
    conditionId: `condition-${suffix}`, strategyVersion: "strategy-v1", mode: "paper", route: "DIRECT_BUY_BOTH",
    dispatchModel: suffix === "c" ? "UP_THEN_DOWN" : "PARALLEL", settlementPolicy: "HOLD_TO_RESOLUTION",
    recoveryPolicy: "NO_AUTO_RECOVERY", idempotencyKey: `group-idem-${suffix}`, requestHash: `group-hash-${suffix}`,
    signalCaptureId: `capture-${suffix}`, state, targetGrossShares6: 1_000_000n, approvedCashCap6: 900_000n,
    approvedResidualLoss6: 100_000n, reservedCash6: state.startsWith("RECONCILED") ? 0n : 900_000n,
    signalNetPnl6: 10_000n, activationNetPnl6: suffix === "a" ? 8_000n : null, stressResultsJson: {},
    activateAtMs: createdAtMs + 10, reconciliationStatus: "PENDING", createdAtMs, updatedAtMs: createdAtMs,
    ...overrides,
  } as typeof schema.pairOrderGroups.$inferInsert;
}

describe("pair read repository pagination and validation", () => {
  it("uses stable timestamp/id cursors without duplicates across all primary lists", async () => {
    for (const list of [
      (query: Record<string, unknown>) => repository.listEpisodes(query),
      (query: Record<string, unknown>) => repository.listObservations(query),
      (query: Record<string, unknown>) => repository.listGroups(query),
      (query: Record<string, unknown>) => repository.listResearchRuns(query),
    ]) {
      const first = await list({ limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const second = await list({ limit: 2, cursor: first.nextCursor! });
      expect(second.items).toHaveLength(1);
      const ids = [...first.items, ...second.items].map((item) => item.id);
      expect(new Set(ids).size).toBe(3);
    }
  });

  it("rejects malformed cursors, unknown filters, invalid enums, precision loss, and excessive limits", async () => {
    await expect(repository.listGroups({ cursor: "not+base64" })).rejects.toBeInstanceOf(PairReadModelValidationError);
    const extraCursor = Buffer.from(JSON.stringify({ tsMs: "1", id: "x", extra: true })).toString("base64url");
    await expect(repository.listGroups({ cursor: extraCursor })).rejects.toThrow("cursor payload fields are invalid");
    await expect(repository.listGroups({ surprise: "x" })).rejects.toThrow("unsupported filters");
    await expect(repository.listGroups({ state: "INVENTED" })).rejects.toThrow("supported group state");
    await expect(repository.listGroups({ limit: 201 })).rejects.toThrow("limit must be between");
    await expect(repository.listObservations({ minimum_net_pnl6: "1.5" })).rejects.toThrow("exact decimal integer");
    await expect(repository.listObservations({ primary_rejection_code: "MADE_UP" })).rejects.toThrow("primary_rejection_code is unsupported");
  });

  it("applies exact filters without converting economic values through number", async () => {
    const residual = await repository.listGroups({ has_residual: "true", dispatch_model: "PARALLEL" });
    expect(residual.items.map((item) => item.id)).toEqual(["group-b"]);
    const positive = await repository.listObservations({ minimum_net_pnl6: "0" });
    expect(positive.items.map((item) => item.id)).toEqual(["observation-c", "observation-b"]);
  });
});

describe("pair read repository exact summary and details", () => {
  it("returns exact health, current totals, and trailing totals as route-ready strings", async () => {
    const summary = await repository.getSummary(now);
    expect(summary.capability).toMatchObject({ observerEnabled: true, paperExecutionEnabled: true, liveExecutionAvailable: false });
    expect(summary.health).toMatchObject({ status: "DEGRADED", paperSchedulingAllowed: false, unknownOutcomeGroupCount: 1, runtime: { feedIntegrity: "HEALTHY", exactLagCount: "9000000000000000000" } });
    expect(summary.current).toEqual({
      openEpisodes: 2,
      activeGroups: 2,
      residualGroups: 1,
      unknownOutcomeGroups: 1,
      manualReviewGroups: 0,
      pairCashAvailable6: "9000000000000000000",
      pairCashReserved6: "200",
    });
    expect(summary.trailing24h).toEqual({
      evaluatedEnvelopes: "10",
      episodes: 3,
      grossDislocations: "4",
      feePositiveObservations: "3",
      activationSurvivors: 1,
      paperGroups: 3,
      pairedGroups: 1,
      residualGroups: 1,
      realizedPnl6: "700",
    });
  });

  it("stringifies every bigint in lists and nested detail children", async () => {
    const episodes = await repository.listEpisodes();
    expect(typeof episodes.items[0]!.envelopeCount).toBe("string");
    const observations = await repository.listObservations();
    expect(observations.items[0]!.requestedCashCap6).toBe("9000000000000000000");
    const groups = await repository.listGroups();
    expect(groups.items[0]!.targetGrossShares6).toBe("1000000");
    const runs = await repository.listResearchRuns();
    expect(runs.items[0]!.eventCount).toBe("9000000000000000002");
    const detail = await repository.getGroup("group-a");
    expect(detail).not.toBeNull();
    expect((detail!.inventoryLots as Array<Record<string, unknown>>)[0]!.principalCost6).toBe("400000");
    expect((detail!.ledgerEntries as Array<Record<string, unknown>>)[0]!.amount6).toBe("1000");
    const orders = detail!.orders as Array<Record<string, unknown>>;
    expect(orders[0]!.shares6).toBe("9007199254740993");
    expect(((orders[0]!.fills as Array<Record<string, unknown>>)[0]!.shares6)).toBe("9007199254740992");
    const observation = await repository.getObservation("observation-a");
    expect((observation!.capture as Record<string, unknown>).captureSequence).toBe("1");
    const run = await repository.getResearchRun("run-a");
    expect((run!.scenarios as unknown[])).toHaveLength(1);
    expect((run!.artifacts as unknown[])).toHaveLength(1);
  });

  it("joins the complete group audit graph with deterministic fixed-count batches", async () => {
    const detail = await repository.getGroup("group-a");
    expect(detail).not.toBeNull();
    expect(detail!.signal).toMatchObject({
      captureId: "capture-a",
      decision: { decisionId: "decision-a", correlationId: "correlation-a" },
      riskDecision: { id: "risk-a", capChain: { cashCap6: "9007199254740993", residualLossCap6: "100000" } },
    });
    expect(detail!.activation).toMatchObject({ captureId: null, decision: null, riskDecision: null });

    const actions = detail!.actions as Array<Record<string, unknown>>;
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      id: "action-a",
      decision: { decisionId: "decision-action", data: { kind: "pair_activation" } },
      riskDecision: { id: "risk-action", reasons: [{ code: "ALL_GATES_PASSED" }] },
      orderIntent: { id: "order-intent-action", payload: { targetGrossShares6: "9007199254740993" } },
    });
    expect(actions[0]!.effects).toHaveLength(1);
    expect(actions[0]!.orders).toHaveLength(2);

    const orders = detail!.orders as Array<Record<string, unknown>>;
    expect(orders.map((order) => order.id)).toEqual(["order-a-up", "order-a-down"]);
    expect((orders[0]!.fills as Array<Record<string, unknown>>).map((fill) => fill.id)).toEqual(["fill-a", "fill-a-level-2"]);
    expect((orders[1]!.fills as Array<Record<string, unknown>>).map((fill) => fill.id)).toEqual(["fill-a-down"]);

    const reconciliations = detail!.reconciliations as Array<Record<string, unknown>>;
    expect(reconciliations.map((run) => run.id)).toEqual(["reconciliation-a1", "reconciliation-a2"]);
    expect(reconciliations.map((run) => (run.diffs as unknown[]).length)).toEqual([1, 1]);
    expect(queries.filter((name) => name === "groups.detail")).toHaveLength(1);
    expect(queries.filter((name) => name === "groups.children.batch")).toHaveLength(1);
    expect(queries.filter((name) => name === "groups.related.batch")).toHaveLength(1);
  });

  it("serves the expanded exact audit graph over the GET-only HTTP route", async () => {
    const app = Fastify({ logger: false });
    registerPairReadRoutes(app, { repository, guard: async () => true, nowMs: () => now });
    await app.ready();
    try {
      const response = await app.inject({ method: "GET", url: "/api/pairs/groups/group-a" });
      expect(response.statusCode).toBe(200);
      const body = response.json() as Record<string, unknown>;
      expect(((body.signal as Record<string, unknown>).riskDecision as Record<string, unknown>).capChain).toMatchObject({ cashCap6: "9007199254740993" });
      const orders = body.orders as Array<Record<string, unknown>>;
      expect(orders[0]!.shares6).toBe("9007199254740993");
      expect((orders[0]!.fills as unknown[])).toHaveLength(2);
      expect((body.reconciliations as Array<Record<string, unknown>>)[1]!.diffs).toHaveLength(1);

      const missing = await app.inject({ method: "GET", url: "/api/pairs/groups/does-not-exist" });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: "pair_resource_not_found" });
      for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
        expect((await app.inject({ method, url: "/api/pairs/groups/group-a" })).statusCode).toBe(404);
      }
    } finally {
      await app.close();
    }
  });

  it("loads reconciliation diffs in one batch rather than one query per reconciliation", async () => {
    const result = await repository.listGroupReconciliations("group-a");
    expect(result.items).toHaveLength(2);
    expect((result.items[0]!.diffs as unknown[])).toHaveLength(1);
    expect((result.items[1]!.diffs as unknown[])).toHaveLength(1);
    expect(queries.filter((name) => name === "groups.reconciliation-diffs.batch")).toHaveLength(1);
    expect(queries.filter((name) => name.startsWith("groups.reconciliation"))).toHaveLength(2);
  });

  it("returns independently paginated ordered events and null for unknown detail IDs", async () => {
    const first = await repository.listGroupEvents("group-a", { limit: 1 });
    expect(first.items.map((item) => item.id)).toEqual(["event-a2"]);
    const second = await repository.listGroupEvents("group-a", { limit: 1, cursor: first.nextCursor! });
    expect(second.items.map((item) => item.id)).toEqual(["event-a1"]);
    await expect(repository.getGroup("missing")).resolves.toBeNull();
    await expect(repository.getEpisode("missing")).resolves.toBeNull();
    await expect(repository.getObservation("missing")).resolves.toBeNull();
    await expect(repository.getResearchRun("missing")).resolves.toBeNull();
  });
});

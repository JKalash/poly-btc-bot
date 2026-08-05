import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeDb, schema, type DbHandle } from "@b5p/db";
import { canonicalObjectHash, type PairGroupId } from "@b5p/pair-execution";
import {
  buyFillJournal,
  createInventoryLot,
  reserveCashJournal,
  sellRecoveryJournal,
  type JournalContext,
  type PairInventoryLot,
  type PairLedgerEntry,
} from "@b5p/pair-execution/internal/ledger";
import {
  PairAccountIdempotencyCollisionError,
  PairAccountStore,
  PairAccountValidationError,
} from "../src/pair-account-store";
import { eq } from "drizzle-orm";

const now = 1_800_000_000_000;
const ACCOUNT = "pair-account";
const GROUP_A = "group-a" as PairGroupId;
const GROUP_B = "group-b" as PairGroupId;
let handle: DbHandle;
let store: PairAccountStore;

beforeEach(async () => {
  handle = await makeDb({ pgliteDir: "memory://" });
  await handle.migrate();
  store = new PairAccountStore(handle);
  await seedDirectionalState();
  await seedPairParents();
  await store.createAccount({
    id: ACCOUNT,
    sessionKey: "runtime-pair-session",
    sourceConfigVersion: 7,
    startingCash6: 10_000n,
    dailyBucketUtc: "2027-01-15",
    createdAtMs: now,
  });
  await seedGroups();
});

afterEach(async () => { await handle.close(); });

async function seedDirectionalState(): Promise<void> {
  await handle.db.insert(schema.bankrollSnapshots).values({
    mode: "paper",
    bankroll6: 777_000_000n,
    basis: "directional-control",
    tsMs: now - 100,
  });
  await handle.db.insert(schema.positions).values({
    id: "directional-position",
    marketId: "directional-market",
    mode: "paper",
    outcomeSide: "UP",
    shares6: 2_000_000n,
    avgPrice6: 400_000n,
    cost6: 800_000n,
    fees6: 1_000n,
    stake6: 801_000n,
    exitPolicy: "hold",
    status: "OPEN",
    openedAtMs: now - 100,
  });
  await handle.db.insert(schema.tradingSessions).values({
    id: "directional-session",
    mode: "paper",
    startedAtMs: now - 100,
    startingBankroll6: 777_000_000n,
    peakBankroll6: 777_000_000n,
    realized6: 0n,
  });
}

async function seedPairParents(): Promise<void> {
  await handle.db.insert(schema.pairBookCaptures).values({
    id: "capture", marketId: "market-a", conditionId: "condition", captureKind: "SIGNAL",
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
    id: "observation", marketId: "market-a", conditionId: "condition", strategyVersion: "strategy",
    mode: "paper", observationKind: "NET_ELIGIBLE", triggerKind: "CLOB_ENVELOPE", triggerId: "trigger",
    captureId: "capture", captureHash: "capture-hash", upFeeSnapshotId: "fee-up", downFeeSnapshotId: "fee-down",
    upConstraintSnapshotId: "constraint-up", downConstraintSnapshotId: "constraint-down",
    policyHash: "policy", observerOperationalHash: "ops", configVersion: 7,
    requestedCashCap6: 1_000n, rejectionCodes: [], captureSummaryJson: {}, decisionJson: {},
    observedAtMs: now, createdAtMs: now,
  });
  await handle.db.insert(schema.decisionSnapshots).values({
    decisionId: "signal-decision", marketId: "market-a", mode: "paper", correlationId: "correlation",
    data: { kind: "complete_set_pair_signal_v1" }, createdAtMs: now,
  });
  await handle.db.insert(schema.riskDecisions).values({
    id: "signal-risk", decisionId: "signal-decision", approved: true, reasons: [], capChain: {}, createdAtMs: now,
  });
}

async function seedGroups(): Promise<void> {
  const base = {
    observationId: "observation", pairAccountId: ACCOUNT, signalDecisionId: "signal-decision",
    signalRiskDecisionId: "signal-risk", conditionId: "condition", strategyVersion: "strategy",
    mode: "paper", route: "PAPER", dispatchModel: "PARALLEL", settlementPolicy: "MERGE_OR_RESOLVE",
    recoveryPolicy: "MINIMIZE_WORST_LOSS", signalCaptureId: "capture", state: "SCHEDULED",
    stateVersion: 0, eventSequence: 0, targetGrossShares6: 1n, approvedCashCap6: 1_000n,
    approvedResidualLoss6: 1_000n, reservedCash6: 0n, signalNetPnl6: 1n,
    stressResultsJson: {}, activateAtMs: now, reconciliationStatus: "NOT_STARTED",
    createdAtMs: now, updatedAtMs: now,
  } as const;
  await handle.db.insert(schema.pairOrderGroups).values([
    { ...base, id: GROUP_A, marketId: "market-a", idempotencyKey: "group-a-idem", requestHash: "group-a-hash" },
    { ...base, id: GROUP_B, marketId: "market-b", idempotencyKey: "group-b-idem", requestHash: "group-b-hash" },
  ]);
}

async function seedEvent(groupId: PairGroupId, id: string, sequence: number): Promise<void> {
  await handle.db.insert(schema.pairGroupEvents).values({
    id,
    groupId,
    sequence,
    eventType: "PAIR_ACCOUNTING_EVIDENCE",
    eventSchemaVersion: 1,
    causationId: `cause-${id}`,
    correlationId: `correlation-${groupId}`,
    payload: {},
    occurredAtMs: now + sequence,
    recordedAtMs: now + sequence,
  });
}

function context(journalId: string, groupId: PairGroupId, eventId: string, offset: number): JournalContext {
  return {
    journalId,
    pairAccountId: ACCOUNT,
    groupId,
    causationEventId: eventId,
    causationKind: journalId,
    occurredAtMs: now + offset,
    recordedAtMs: now + offset,
    metadata: { adapter: "pair-account-store-v1" },
  };
}

function lot(input: {
  id: string; groupId: PairGroupId; tokenId?: string; shares6: bigint; principal6: bigint; cashFee6: bigint; acquiredAtMs: number;
}): PairInventoryLot {
  return createInventoryLot({
    lotId: input.id,
    groupId: input.groupId,
    marketId: input.groupId === GROUP_A ? "market-a" : "market-b",
    tokenId: input.tokenId ?? "up",
    outcome: "UP",
    sourceFillId: `fill-${input.id}`,
    grossShares6: input.shares6,
    netShares6: input.shares6,
    principalCost6: input.principal6,
    cashFee6: input.cashFee6,
    shareFee6: 0n,
    acquiredAtMs: input.acquiredAtMs,
  });
}

async function appendBuy(input: { value: PairInventoryLot; eventId: string; journalId: string; version: number }): Promise<void> {
  await seedEvent(input.value.groupId, input.eventId, input.version);
  const result = await store.appendMutation({
    accountId: ACCOUNT,
    expectedStateVersion: input.version,
    expectedEventSequence: input.version,
    lots: [input.value],
    journal: buyFillJournal({
      context: context(input.journalId, input.value.groupId, input.eventId, input.version),
      tokenId: input.value.tokenId,
      outcome: input.value.outcome,
      principal6: input.value.principalCost6,
      cashFee6: input.value.cashFee6,
      grossShares6: input.value.grossShares6,
      shareFee6: input.value.shareFee6,
      netShares6: input.value.netShares6,
      inventoryLotId: input.value.lotId,
      orderId: `order-${input.value.lotId}`,
      fillId: input.value.sourceFillId,
    }),
  });
  expect(result.kind).toBe("APPLIED");
}

async function directionalFingerprint(): Promise<string> {
  return canonicalObjectHash({
    bankroll: await handle.db.select().from(schema.bankrollSnapshots),
    positions: await handle.db.select().from(schema.positions),
    sessions: await handle.db.select().from(schema.tradingSessions),
    orders: await handle.db.select().from(schema.orders),
    fills: await handle.db.select().from(schema.orderFills),
    pnl: await handle.db.select().from(schema.pnlRecords),
  });
}

describe("BPAIR-061 pair account persistence", () => {
  it("funds exactly once, persists reservation transfers, and reconstructs exact balances after adapter restart", async () => {
    const duplicate = await store.createAccount({
      id: ACCOUNT, sessionKey: "runtime-pair-session", sourceConfigVersion: 7,
      startingCash6: 10_000n, dailyBucketUtc: "2027-01-15", createdAtMs: now,
    });
    expect(duplicate.kind).toBe("DUPLICATE");
    expect(await handle.db.select().from(schema.pairLedgerEntries)).toHaveLength(2);
    await expect(store.createAccount({
      id: "different", sessionKey: "runtime-pair-session", sourceConfigVersion: 7,
      startingCash6: 10_000n, dailyBucketUtc: "2027-01-15", createdAtMs: now,
    })).rejects.toBeInstanceOf(PairAccountIdempotencyCollisionError);

    // Regression: the engine derives dailyBucketUtc from the current clock on
    // every boot, so the first restart after 00:00 UTC presents a later day for
    // the same session key. That must reuse the account, not crash startup.
    const nextDay = await store.createAccount({
      id: ACCOUNT, sessionKey: "runtime-pair-session", sourceConfigVersion: 7,
      startingCash6: 10_000n, dailyBucketUtc: "2027-01-16", createdAtMs: now,
    });
    expect(nextDay.kind).toBe("DUPLICATE");
    expect(nextDay.account.dailyBucketUtc).toBe("2027-01-15");
    expect(await handle.db.select().from(schema.pairLedgerEntries)).toHaveLength(2);

    await seedEvent(GROUP_A, "reserve-event", 1);
    expect((await store.appendReservation({
      accountId: ACCOUNT, groupId: GROUP_A, eventId: "reserve-event", journalId: "reserve-journal",
      amount6: 1_000n, expectedStateVersion: 1, expectedEventSequence: 1,
      occurredAtMs: now + 1, recordedAtMs: now + 1,
    })).kind).toBe("APPLIED");

    await seedEvent(GROUP_A, "release-event", 2);
    expect((await store.releaseReservation({
      accountId: ACCOUNT, groupId: GROUP_A, eventId: "release-event", journalId: "release-journal",
      amount6: 250n, expectedStateVersion: 2, expectedEventSequence: 2,
      occurredAtMs: now + 2, recordedAtMs: now + 2,
    })).kind).toBe("APPLIED");

    const restarted = new PairAccountStore(handle);
    const state = await restarted.loadState(ACCOUNT);
    expect(state?.ledger).toMatchObject({ cashAvailable6: 9_250n, cashReserved6: 750n, accountCash6: 10_000n });
    expect(state?.account).toMatchObject({ cashAvailable6: 9_250n, cashReserved6: 750n, stateVersion: 3, eventSequence: 3 });
    expect(state?.ledgerEntries).toHaveLength(6);

    const before = await handle.db.select().from(schema.pairLedgerEntries);
    expect((await store.releaseReservation({
      accountId: ACCOUNT, groupId: GROUP_A, eventId: "release-event", journalId: "release-journal",
      amount6: 250n, expectedStateVersion: 2, expectedEventSequence: 2,
      occurredAtMs: now + 2, recordedAtMs: now + 2,
    })).kind).toBe("DUPLICATE");
    expect(await handle.db.select().from(schema.pairLedgerEntries)).toEqual(before);
  });

  it("persists immutable acquisition lots and exact group-local FIFO consumptions", async () => {
    await seedEvent(GROUP_A, "reserve-event", 1);
    expect((await store.appendReservation({
      accountId: ACCOUNT, groupId: GROUP_A, eventId: "reserve-event", journalId: "reserve-journal",
      amount6: 1_000n, expectedStateVersion: 1, expectedEventSequence: 1,
      occurredAtMs: now + 1, recordedAtMs: now + 1,
    })).kind).toBe("APPLIED");

    const first = lot({ id: "a-first", groupId: GROUP_A, shares6: 3n, principal6: 10n, cashFee6: 2n, acquiredAtMs: now + 2 });
    const second = lot({ id: "a-second", groupId: GROUP_A, shares6: 2n, principal6: 9n, cashFee6: 1n, acquiredAtMs: now + 3 });
    const foreign = lot({ id: "b-foreign", groupId: GROUP_B, shares6: 100n, principal6: 100n, cashFee6: 0n, acquiredAtMs: now + 4 });
    await appendBuy({ value: first, eventId: "buy-a-first", journalId: "buy-a-first-journal", version: 2 });
    await appendBuy({ value: second, eventId: "buy-a-second", journalId: "buy-a-second-journal", version: 3 });
    await appendBuy({ value: foreign, eventId: "buy-b-foreign", journalId: "buy-b-foreign-journal", version: 4 });

    await seedEvent(GROUP_A, "sell-a", 5);
    const consumed = await store.appendFifoConsumption({
      accountId: ACCOUNT,
      groupId: GROUP_A,
      tokenId: "up",
      shares6: 4n,
      eventId: "sell-a",
      consumptionKind: "SELL_RECOVERY",
      createdAtMs: now + 5,
      expectedStateVersion: 5,
      expectedEventSequence: 5,
      buildJournal: (allocation) => sellRecoveryJournal({
        context: context("sell-a-journal", GROUP_A, "sell-a", 5),
        tokenId: "up",
        outcome: "UP",
        grossProceeds6: 20n,
        cashFee6: 1n,
        netProceeds6: 19n,
        sharesSold6: 4n,
        allocatedPrincipalCost6: allocation.allocatedPrincipalCost6,
        inventoryConsumptionId: allocation.consumptions[0]?.consumptionId ?? null,
        orderId: "sell-order",
        fillId: "sell-fill",
      }),
    });
    expect(consumed.kind).toBe("APPLIED");
    if (consumed.kind === "INSUFFICIENT_INVENTORY") throw new Error("expected persisted FIFO consumption");
    expect(consumed.consumptions?.map(({ lotId, shares6, allocatedPrincipalCost6, allocatedBuyCashFee6 }) =>
      [lotId, shares6, allocatedPrincipalCost6, allocatedBuyCashFee6])).toEqual([
      ["a-first", 3n, 10n, 2n],
      ["a-second", 1n, 4n, 0n],
    ]);

    const rows = await handle.db.select().from(schema.pairInventoryConsumptions)
      .where(eq(schema.pairInventoryConsumptions.groupId, GROUP_A));
    expect(rows).toHaveLength(2);
    expect(rows.some(({ lotId }) => lotId === "b-foreign")).toBe(false);
    const state = await new PairAccountStore(handle).loadState(ACCOUNT);
    expect(state?.holdingsByToken).toEqual({ up: 101n });
    expect(state?.ledger.tokenInventoryByAsset).toEqual({ up: 101n });

    const insufficient = await store.appendFifoConsumption({
      accountId: ACCOUNT, groupId: GROUP_A, tokenId: "up", shares6: 2n, eventId: "sell-too-much",
      consumptionKind: "SELL_RECOVERY", createdAtMs: now + 6,
      expectedStateVersion: 6, expectedEventSequence: 6,
      buildJournal: () => { throw new Error("must not build a journal"); },
    });
    expect(insufficient).toEqual({ kind: "INSUFFICIENT_INVENTORY", availableShares6: 1n, requestedShares6: 2n });
  });

  it("rejects unbalanced or over-releasing journals atomically and never touches directional accounting", async () => {
    const directionalBefore = await directionalFingerprint();
    await seedEvent(GROUP_A, "reserve-event", 1);
    expect((await store.appendReservation({
      accountId: ACCOUNT, groupId: GROUP_A, eventId: "reserve-event", journalId: "reserve-journal",
      amount6: 100n, expectedStateVersion: 1, expectedEventSequence: 1,
      occurredAtMs: now + 1, recordedAtMs: now + 1,
    })).kind).toBe("APPLIED");

    await seedEvent(GROUP_A, "bad-event", 2);
    const balanced = reserveCashJournal(context("bad-journal", GROUP_A, "bad-event", 2), 1n);
    const corruptEntries: PairLedgerEntry[] = balanced.entries.map((entry, index) =>
      index === 0 ? { ...entry, amount6: entry.amount6 + 1n } : entry);
    await expect(store.appendMutation({
      accountId: ACCOUNT,
      expectedStateVersion: 2,
      expectedEventSequence: 2,
      journal: { journalId: balanced.journalId, entries: corruptEntries },
    })).rejects.toThrow(/UNBALANCED_JOURNAL/);

    await seedEvent(GROUP_A, "over-release-event", 3);
    await expect(store.releaseReservation({
      accountId: ACCOUNT, groupId: GROUP_A, eventId: "over-release-event", journalId: "over-release-journal",
      amount6: 101n, expectedStateVersion: 2, expectedEventSequence: 2,
      occurredAtMs: now + 3, recordedAtMs: now + 3,
    })).rejects.toBeInstanceOf(PairAccountValidationError);
    const account = await store.loadState(ACCOUNT);
    expect(account?.account).toMatchObject({ stateVersion: 2, eventSequence: 2, cashReserved6: 100n });
    expect(await directionalFingerprint()).toBe(directionalBefore);
  });
});

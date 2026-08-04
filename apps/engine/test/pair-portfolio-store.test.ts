import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeDb, schema, type DbHandle } from "@b5p/db";
import { PairPortfolioSnapshotError, PairPortfolioStore } from "../src/pair-portfolio-store";

const now = 1_800_000_000_000;
let handle: DbHandle;
let store: PairPortfolioStore;

beforeEach(async () => {
  handle = await makeDb({ pgliteDir: "memory://" });
  await handle.migrate();
  store = new PairPortfolioStore(handle);
  await handle.db.insert(schema.pairPaperAccounts).values({
    id: "account", accountModel: "ISOLATED_PAIR_PAPER", sessionKey: "session",
    sourceConfigVersion: 1, startingCash6: 100_000_000n, cashAvailable6: 80_000_000n,
    cashReserved6: 20_000_000n, cashDebits6: 0n, cashCredits6: 0n, realizedPnl6: -1_000_000n,
    peakCash6: 110_000_000n, sessionDrawdown6: 10_000_000n, dailyRealizedPnl6: -500_000n,
    dailyBucketUtc: "2027-01-15", activeGroupCount: 1, aggregateWorstCaseLoss6: 4_000_000n,
    eventSequence: 3, stateVersion: 4, reconciliationStatus: "HEALTHY", lastReconciledAtMs: now - 1,
    createdAtMs: now - 10, updatedAtMs: now - 1,
  });
});

afterEach(async () => { await handle.close(); });

async function seedDirectionalRows(): Promise<void> {
  await handle.db.insert(schema.decisionSnapshots).values({
    decisionId: "decision", marketId: "directional-order-market", mode: "paper",
    correlationId: "correlation", data: {}, createdAtMs: now,
  });
  await handle.db.insert(schema.orderIntents).values({
    id: "intent", decisionId: "decision", version: 1, idempotencyKey: "intent-key", payload: {}, createdAtMs: now,
  });
  await handle.db.insert(schema.orders).values({
    id: "order", intentId: "intent", decisionId: "decision", marketId: "directional-order-market",
    tokenId: "token", outcomeSide: "UP", orderSide: "BUY", style: "maker_post_only", timeInForce: "GTD",
    postOnly: true, price6: 500_000n, shares6: 1_000_000n, filledShares6: 0n, stake6: 500_000n,
    mode: "paper", status: "LIVE", createdAtMs: now, updatedAtMs: now,
  });
  await handle.db.insert(schema.positions).values({
    id: "position", marketId: "directional-position-market", mode: "paper", outcomeSide: "DOWN",
    shares6: 1_000_000n, avgPrice6: 400_000n, cost6: 400_000n, fees6: 0n, stake6: 400_000n,
    exitPolicy: "hold", status: "OPEN", openedAtMs: now,
  });
}

describe("pair portfolio snapshot", () => {
  it("combines exact isolated account balances with directional exposure facts", async () => {
    await seedDirectionalRows();
    const result = await store.snapshot({
      accountId: "account", referenceBankroll6: 100_000_000n, directionalFreeCash6: 70_000_000n,
      globalAppMode: "paper", directionalLiveArmed: false, asOfMs: now,
    });
    expect(result).toMatchObject({
      pairAccountCashBalance6: 100_000_000n, pairCashAvailable6: 80_000_000n,
      pairCashReserved6: 20_000_000n, sharedCapAvailable6: 70_000_000n,
      aggregatePairWorstCaseLoss6: 4_000_000n, pairDailyRealizedPnl6: -500_000n,
      activeDirectionalMarketIds: ["directional-order-market"],
      openDirectionalMarketIds: ["directional-position-market"], healthy: true,
    });
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.snapshotId).toContain(result.hash.slice(0, 16));
  });

  it("fails health closed before reconciliation and rejects a missing account", async () => {
    await handle.db.update(schema.pairPaperAccounts).set({ reconciliationStatus: "NOT_STARTED", lastReconciledAtMs: null });
    expect((await store.snapshot({
      accountId: "account", referenceBankroll6: 1n, directionalFreeCash6: 0n,
      globalAppMode: "observe", directionalLiveArmed: false, asOfMs: now,
    })).healthy).toBe(false);
    await expect(store.snapshot({
      accountId: "missing", referenceBankroll6: 1n, directionalFreeCash6: 0n,
      globalAppMode: "observe", directionalLiveArmed: false, asOfMs: now,
    })).rejects.toBeInstanceOf(PairPortfolioSnapshotError);
  });
});

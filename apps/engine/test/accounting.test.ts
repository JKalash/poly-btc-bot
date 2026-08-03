import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bankrollSnapshots, makeDb, tradingSessions, type DbHandle } from "@b5p/db";
import { DEFAULT_CONFIG } from "@b5p/config";
import { Accounting } from "../src/accounting";

let db: DbHandle;

beforeEach(async () => {
  db = await makeDb({ pgliteDir: "memory://", databaseUrl: undefined });
  await db.migrate();
});
afterEach(async () => { await db.close(); });

/**
 * #61: the loss stops must survive restarts. A restart used to zero the
 * consecutive-loss counter (auto-re-arming a tripped stop) and re-seed the
 * daily peak from the post-loss bankroll (granting a fresh daily budget).
 */
describe("reconcile restores loss-stop state (#61)", () => {
  it("carries consecutiveLosses over from the latest persisted session", async () => {
    const nowMs = Date.UTC(2026, 7, 3, 12, 0, 0);
    await db.db.insert(tradingSessions).values({
      id: "prev-session", mode: "paper", startedAtMs: nowMs - 3_600_000,
      startingBankroll6: 1_000_000_000n, peakBankroll6: 1_000_000_000n,
      realized6: -100_000_000n, consecutiveLosses: 2,
    });
    const acc = new Accounting(db, "paper");
    await acc.reconcile(DEFAULT_CONFIG, nowMs);
    expect(acc.consecutiveLosses).toBe(2); // stop still armed after restart
    // and the new session row records the carried-over counter
    const rows = await db.db.select().from(tradingSessions);
    const fresh = rows.find((r) => r.id === acc.sessionId)!;
    expect(fresh.consecutiveLosses).toBe(2);
  });

  it("restores dailyPeak from the UTC-day's maximum bankroll snapshot, not the current bankroll", async () => {
    const nowMs = Date.UTC(2026, 7, 3, 12, 0, 0);
    // morning: peak 1100, then losses down to 900 (latest snapshot)
    await db.db.insert(bankrollSnapshots).values([
      { mode: "paper", bankroll6: 1_100_000_000n, basis: "paper_resolution", tsMs: nowMs - 2 * 3_600_000 },
      { mode: "paper", bankroll6: 900_000_000n, basis: "paper_resolution", tsMs: nowMs - 3_600_000 },
      // yesterday's higher peak must NOT count toward today's budget
      { mode: "paper", bankroll6: 2_000_000_000n, basis: "paper_resolution", tsMs: nowMs - 30 * 3_600_000 },
    ]);
    const acc = new Accounting(db, "paper");
    await acc.reconcile(DEFAULT_CONFIG, nowMs);
    expect(acc.bankroll).toBe(900_000_000n);
    expect(acc.dailyPeak).toBe(1_100_000_000n); // today's true peak, not 900
  });

  it("resetLossStop clears the counter and persists it (operator manual re-arm)", async () => {
    const nowMs = Date.UTC(2026, 7, 3, 12, 0, 0);
    await db.db.insert(tradingSessions).values({
      id: "prev", mode: "paper", startedAtMs: nowMs - 1000,
      startingBankroll6: 1_000_000_000n, peakBankroll6: 1_000_000_000n,
      realized6: 0n, consecutiveLosses: 3,
    });
    const acc = new Accounting(db, "paper");
    await acc.reconcile(DEFAULT_CONFIG, nowMs);
    expect(acc.consecutiveLosses).toBe(3);
    await acc.resetLossStop();
    expect(acc.consecutiveLosses).toBe(0);
    const rows = await db.db.select().from(tradingSessions);
    expect(rows.find((r) => r.id === acc.sessionId)!.consecutiveLosses).toBe(0);
  });
});

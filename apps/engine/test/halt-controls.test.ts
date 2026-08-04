import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { healthEvents, killSwitchEvents, makeDb, markets as marketsTable, type DbHandle } from "@b5p/db";
import type { ParsedFiveMinMarket } from "@b5p/polymarket";
import { eq } from "drizzle-orm";
import { getLocalBus } from "../src/bus";
import { Engine } from "../src/engine";

let db: DbHandle;
let engine: Engine;

const START = 1_785_500_100;
const startEpoch = Math.floor(START / 300) * 300;
const endEpoch = startEpoch + 300;
const NOW0 = (endEpoch - 90) * 1000;

function market(overrides: Partial<ParsedFiveMinMarket> = {}): ParsedFiveMinMarket {
  return {
    eventId: "ev1", marketId: "m1", conditionId: "0xcond",
    slug: `btc-updown-5m-${startEpoch}`, question: "BTC up or down",
    description: "Resolves Up if... Chainlink ... BTC/USD data stream",
    resolutionSource: "https://data.chain.link/streams/btc-usd",
    startEpoch, endEpoch, upTokenId: "tok-up", downTokenId: "tok-down",
    tickSize: 0.01, minOrderSize: 5, negRisk: false,
    active: true, closed: false, acceptingOrders: true,
    bestBid: 0.55, bestAsk: 0.56, volumeUsd: 50_000, outcomePrices: null,
    feeSchedule: { rate: 0.07, takerOnly: true, rebateRate: 0.2, feeType: "crypto_fees_v2" },
    rulesNameChainlink: true, raw: {} as ParsedFiveMinMarket["raw"],
    ...overrides,
  };
}

beforeEach(async () => {
  db = await makeDb({ pgliteDir: "memory://", databaseUrl: undefined });
  await db.migrate();
  engine = new Engine(db, getLocalBus(), "paper");
  await engine.start(NOW0 - 1000);
});

afterEach(async () => {
  engine.stop();
  await db.close();
});

describe("kill-switch DB fallback (#27)", () => {
  it("halts on a kill_switch_events row even with no bus delivery", async () => {
    // simulate the API (separate process, dead bus) writing the row directly
    await db.db.insert(killSwitchEvents).values({
      id: "k1", scope: "api", reason: "operator emergency stop", actor: "operator", createdAtMs: NOW0,
    });
    expect(engine.engineState).not.toBe("HALTED");
    await engine.step(NOW0 + 2500); // poll interval is 2s
    expect(engine.engineState).toBe("HALTED");
  });

  it("ignores kill rows that predate engine start (already handled by a prior run)", async () => {
    await db.db.insert(killSwitchEvents).values({
      id: "k-old", scope: "api", reason: "yesterday's stop", actor: "operator", createdAtMs: NOW0 - 60_000,
    });
    const engine2 = new Engine(db, getLocalBus(), "paper");
    await engine2.start(NOW0);
    await engine2.step(NOW0 + 2500);
    expect(engine2.engineState).not.toBe("HALTED"); // historical row, not a fresh kill
    engine2.stop();
  });
});

describe("halt wiring (#60)", () => {
  it("halts on duplicate market identity (token collision)", async () => {
    await engine.upsertDiscoveredMarkets([market()], NOW0 - 1000);
    expect(engine.engineState).not.toBe("HALTED");
    await engine.upsertDiscoveredMarkets(
      [market({ marketId: "m2", slug: `btc-updown-5m-${startEpoch + 300}`, startEpoch: startEpoch + 300, endEpoch: endEpoch + 300 })],
      NOW0,
    ); // same tok-up/tok-down under a different market id
    expect(engine.engineState).toBe("HALTED");
  });

  it("updates a changed fee schedule with a health warning when not armed (no halt)", async () => {
    await engine.upsertDiscoveredMarkets([market()], NOW0 - 1000);
    await engine.upsertDiscoveredMarkets(
      [market({ feeSchedule: { rate: 0.09, takerOnly: true, rebateRate: 0.2, feeType: "crypto_fees_v2" } })],
      NOW0,
    );
    expect(engine.engineState).not.toBe("HALTED");
    const warns = await db.db.select().from(healthEvents).where(eq(healthEvents.kind, "fees"));
    expect(warns.length).toBe(1);
  });
});

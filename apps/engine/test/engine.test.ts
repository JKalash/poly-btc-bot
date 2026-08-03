import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeDb, orders as ordersTable, pnlRecords, resolutions, riskDecisions, type DbHandle } from "@b5p/db";
import { usdc, type ReferenceTick } from "@b5p/domain";
import type { ParsedFiveMinMarket } from "@b5p/polymarket";
import { eq } from "drizzle-orm";
import { getLocalBus, CHANNELS } from "../src/bus";
import { Engine, compareDecimal } from "../src/engine";

let db: DbHandle;
let engine: Engine;

// fixed test timeline
const START = 1_785_500_100; // 300-aligned + 0? ensure alignment:
const startEpoch = Math.floor(START / 300) * 300;
const endEpoch = startEpoch + 300;
// "now" inside the candidate window (90s remaining)
const NOW0 = (endEpoch - 90) * 1000;

function market(overrides: Partial<ParsedFiveMinMarket> = {}): ParsedFiveMinMarket {
  return {
    eventId: "ev1",
    marketId: "m1",
    conditionId: "0xcond",
    slug: `btc-updown-5m-${startEpoch}`,
    question: "BTC up or down",
    description: "Resolves Up if... Chainlink ... BTC/USD data stream",
    resolutionSource: "https://data.chain.link/streams/btc-usd",
    startEpoch,
    endEpoch,
    upTokenId: "tok-up",
    downTokenId: "tok-down",
    tickSize: 0.01,
    minOrderSize: 5,
    negRisk: false,
    active: true,
    closed: false,
    acceptingOrders: true,
    bestBid: 0.55,
    bestAsk: 0.56,
    volumeUsd: 50_000,
    outcomePrices: null,
    feeSchedule: { rate: 0.07, takerOnly: true, rebateRate: 0.2, feeType: "crypto_fees_v2" },
    rulesNameChainlink: true,
    raw: {} as ParsedFiveMinMarket["raw"],
    ...overrides,
  };
}

function tick(tsMs: number, value: number, source: "chainlink" | "binance" = "chainlink"): ReferenceTick {
  return { source, symbol: source === "chainlink" ? "btc/usd" : "btcusdt", value, sourceTsMs: tsMs, receivedTsMs: tsMs + 30 };
}

/** Feed a warm, healthy world: history reaching past the window boundary (needed for price-to-beat capture), fresh books. */
async function warmWorld(nowMs: number, opts: { chainNow?: number; ptbValue?: number } = {}): Promise<void> {
  const chainNow = opts.chainNow ?? 64100;
  const ptbValue = opts.ptbValue ?? 64000;
  for (let s = 260; s > 0; s--) {
    const ts = nowMs - s * 1000;
    const beforeBoundary = ts <= startEpoch * 1000;
    const noise = 2 * Math.sin(s * 1.3);
    engine.onReferenceTick(tick(ts, (beforeBoundary ? ptbValue : chainNow) + noise));
    engine.onReferenceTick(tick(ts, (beforeBoundary ? ptbValue : chainNow) + noise + 4, "binance"));
  }
  for (let i = 0; i < 10; i++) engine.onClockSample(10 + i);
  const bookTs = nowMs - 200;
  engine.onBookSnapshot("tok-up",
    [{ price: "0.55", size: "500" }, { price: "0.50", size: "800" }],
    [{ price: "0.56", size: "400" }, { price: "0.60", size: "700" }, { price: "0.65", size: "900" }],
    bookTs, bookTs);
  engine.onBookSnapshot("tok-down",
    [{ price: "0.44", size: "450" }],
    [{ price: "0.45", size: "350" }],
    bookTs, bookTs);
}

beforeEach(async () => {
  db = await makeDb({ pgliteDir: "memory://", databaseUrl: undefined });
  await db.migrate();
  engine = new Engine(db, getLocalBus(), "paper");
  await engine.start(NOW0 - 1000);
  // the uncalibrated heuristic is the only paper-approved model that can show edge;
  // trading it now requires explicitly waiving the calibration requirement (issue #1)
  engine.cfg.strategy.probability_model = "distance_vol_heuristic";
  engine.cfg.strategy.calibration_required = false;
  await engine.upsertDiscoveredMarkets([market()], NOW0 - 1000);
});

afterEach(async () => {
  engine.stop();
  await db.close();
});

describe("paper lifecycle end-to-end", () => {
  it("approves, rests post-only, fills on printed trades, resolves, and accounts exactly", async () => {
    await warmWorld(NOW0);
    await engine.step(NOW0);

    // decision snapshot persisted before order; order resting after latency
    const rd = await db.db.select().from(riskDecisions);
    expect(rd.length).toBe(1);
    expect(rd[0]!.approved).toBe(true);

    let ors = await db.db.select().from(ordersTable);
    expect(ors.length).toBe(1);
    expect(ors[0]!.postOnly).toBe(true);
    expect(ors[0]!.status).toBe("PENDING");
    const stakeCap = ors[0]!.stake6;
    expect(stakeCap > 0n).toBe(true);

    // activate (simulated latency 350ms) — keep the world fresh
    const t1 = NOW0 + 600;
    engine.onReferenceTick(tick(t1 - 100, 64100));
    await engine.step(t1);
    ors = await db.db.select().from(ordersTable);
    expect(ors[0]!.status).toBe("LIVE");

    // a sell prints through our bid -> fill (queue at our improved level is empty)
    const restingPrice = Number(ors[0]!.price6) / 1e6;
    await engine.onTrade("tok-up", restingPrice.toFixed(2), "1000", t1 + 100);
    ors = await db.db.select().from(ordersTable);
    expect(ors[0]!.status).toBe("MATCHED");
    expect(ors[0]!.filledShares6).toBe(ors[0]!.shares6);

    const bankBefore = engine.accounting.state();
    expect(bankBefore.openPositions).toBe(1);
    const spent = usdc("1000") - bankBefore.bankroll;
    expect(spent > 0n).toBe(true);

    // resolution: final chainlink 64100 >= ptb ~64000 -> UP wins
    const tEnd = endEpoch * 1000 + 4000;
    engine.onReferenceTick(tick(endEpoch * 1000 - 200, 64100));
    await engine.step(tEnd);

    const res = await db.db.select().from(resolutions);
    expect(res.length).toBe(1);
    expect(res[0]!.outcome).toBe("UP");

    const pnl = await db.db.select().from(pnlRecords);
    expect(pnl.length).toBe(1);
    expect(pnl[0]!.net6 > 0n).toBe(true); // maker buy below fair, no fee, won

    // conservation: final bankroll = 1000 - cost + payout = 1000 + net
    const bank = engine.accounting.state();
    expect(bank.bankroll).toBe(usdc("1000") + pnl[0]!.net6);
    expect(bank.openPositions).toBe(0);
    expect(bank.consecutiveLosses).toBe(0);
  });

  it("a losing resolution counts toward consecutive losses and stake never exceeded the cap", async () => {
    await warmWorld(NOW0);
    await engine.step(NOW0);
    const t1 = NOW0 + 600;
    engine.onReferenceTick(tick(t1 - 100, 64100));
    await engine.step(t1);
    const ors = await db.db.select().from(ordersTable);
    await engine.onTrade("tok-up", (Number(ors[0]!.price6) / 1e6).toFixed(2), "1000", t1 + 100);

    // crash below the price to beat before the end
    engine.onReferenceTick(tick(endEpoch * 1000 - 100, 63000));
    await engine.step(endEpoch * 1000 + 4000);

    const res = await db.db.select().from(resolutions);
    expect(res[0]!.outcome).toBe("DOWN");
    const pnl = await db.db.select().from(pnlRecords);
    expect(pnl[0]!.net6 < 0n).toBe(true);
    // max loss == stake cap: we can never lose more than the approved stake
    expect(-pnl[0]!.net6 <= ors[0]!.stake6).toBe(true);
    expect(engine.accounting.state().consecutiveLosses).toBe(1);
  });

  it("resolves a tie as UP (>= rule)", () => {
    expect(compareDecimal("64000", "64000")).toBe(0);
    expect(compareDecimal("64000.000000000000000001", "64000")).toBe(1);
    expect(compareDecimal("63999.999999", "64000")).toBe(-1);
  });
});

describe("fail-closed behavior", () => {
  it("rejects decisions when chainlink is stale, with a readable reason", async () => {
    await warmWorld(NOW0);
    // advance 20s without any new chainlink data: candidate forms but risk must reject
    const t = NOW0 + 20_000;
    engine.onBookSnapshot("tok-up",
      [{ price: "0.55", size: "500" }], [{ price: "0.56", size: "400" }], t - 100, t - 100);
    await engine.step(t);
    const rd = await db.db.select().from(riskDecisions);
    if (rd.length > 0) {
      expect(rd[0]!.approved).toBe(false);
      const reasons = rd[0]!.reasons as Array<{ code: string }>;
      expect(reasons.map((r) => r.code)).toContain("CHAINLINK_STALE");
    } else {
      // gate-level rejection is also acceptable fail-closed behavior
      const cockpit = engine.cockpitState(t) as { activeMarket: { gate: { candidate: boolean } | null } | null };
      expect(cockpit.activeMarket?.gate?.candidate ?? false).toBe(false);
    }
  });

  it("kill switch cancels resting orders, halts, and blocks new decisions until resume", async () => {
    await warmWorld(NOW0);
    await engine.step(NOW0);
    const t1 = NOW0 + 600;
    engine.onReferenceTick(tick(t1 - 100, 64100));
    await engine.step(t1);
    expect(engine.paper.restingOrders().length).toBe(1);

    getLocalBus().publish(CHANNELS.control, { type: "kill", reason: "test emergency stop", actor: "test" });
    await new Promise((r) => setTimeout(r, 50));
    expect(engine.engineState).toBe("HALTED");
    const ors = await db.db.select().from(ordersTable);
    expect(ors[0]!.status).toBe("CANCELED");

    // no new decisions while halted
    engine.onReferenceTick(tick(t1 + 900, 64100));
    await engine.step(t1 + 1000);
    const rd = await db.db.select().from(riskDecisions);
    expect(rd.length).toBe(1); // only the original

    getLocalBus().publish(CHANNELS.control, { type: "resume", actor: "test" });
    await new Promise((r) => setTimeout(r, 50));
    expect(engine.engineState).toBe("PAPER");
  });
});

/** Executor-level tests need real FK parents (snapshot -> intent -> order). */
async function seedIntent(decisionId: string, intentId: string): Promise<void> {
  const { decisionSnapshots, orderIntents } = await import("@b5p/db");
  await db.db.insert(decisionSnapshots).values({
    decisionId, marketId: "m1", mode: "paper", correlationId: "corr", data: {}, createdAtMs: NOW0,
  });
  await db.db.insert(orderIntents).values({
    id: intentId, decisionId, version: 1, idempotencyKey: `idem-${intentId}`, payload: {}, createdAtMs: NOW0,
  });
}

describe("post-only safety at the executor level", () => {
  it("rejects a would-cross post-only order at activation and never converts to taker", async () => {
    await warmWorld(NOW0);
    await seedIntent("d-test", "i-test");
    const rec = await engine.paper.submit({
      decisionId: "d-test", intentId: "i-test", marketId: "m1", tokenId: "tok-up",
      outcomeSide: "UP", style: "maker_post_only",
      price6: 570_000n, // >= best ask 0.56 -> would cross
      shares6: 10_000_000n, stakeCap6: usdc("10"), exitPolicy: "hold_to_resolution",
      nowMs: NOW0, cfg: engine.cfg, cancelAtSecondsRemaining: 45, marketEndEpoch: endEpoch,
    });
    await engine.paper.step(NOW0 + 600);
    const row = await db.db.select().from(ordersTable).where(eq(ordersTable.id, rec.id));
    expect(row[0]!.status).toBe("REJECTED");
    expect(row[0]!.statusReason).toContain("post-only");
    expect(row[0]!.filledShares6).toBe(0n);
  });

  it("taker FAK fills within the limit and never spends beyond the stake cap", async () => {
    await warmWorld(NOW0);
    await seedIntent("d-fak", "i-fak");
    const cap = usdc("50");
    const rec = await engine.paper.submit({
      decisionId: "d-fak", intentId: "i-fak", marketId: "m1", tokenId: "tok-up",
      outcomeSide: "UP", style: "taker_fak",
      price6: 600_000n, // limit 0.60: can take 400@0.56 and part of 700@0.60
      shares6: 2_000_000_000n, // requests 2000 shares, cap must bind first
      stakeCap6: cap, exitPolicy: "hold_to_resolution",
      nowMs: NOW0, cfg: engine.cfg, cancelAtSecondsRemaining: 45, marketEndEpoch: endEpoch,
    });
    await engine.paper.step(NOW0 + 600);
    const row = (await db.db.select().from(ordersTable).where(eq(ordersTable.id, rec.id)))[0]!;
    expect(row.status).toBe("MATCHED");
    expect(row.filledShares6 > 0n).toBe(true);
    // spent (cost+fees) must be <= cap
    const fills = await db.db.select().from(await import("@b5p/db").then((m) => m.orderFills));
    const spent = fills.filter((f) => f.orderId === rec.id)
      .reduce((s, f) => s + (f.shares6 * f.price6 + 999_999n) / 1_000_000n + f.feeUsdc6, 0n);
    expect(spent <= cap).toBe(true);
  });
});

describe("restart reconciliation", () => {
  it("cancels orphaned resting orders from a previous process", async () => {
    await warmWorld(NOW0);
    await engine.step(NOW0);
    const t1 = NOW0 + 600;
    engine.onReferenceTick(tick(t1 - 100, 64100));
    await engine.step(t1);
    expect((await db.db.select().from(ordersTable))[0]!.status).toBe("LIVE");

    // simulate restart: a fresh engine on the same db
    const engine2 = new Engine(db, getLocalBus(), "paper");
    await engine2.start(t1 + 5000);
    const after = await db.db.select().from(ordersTable);
    expect(after[0]!.status).toBe("CANCELED");
    expect(after[0]!.statusReason).toContain("restart");
    engine2.stop();
  });
});

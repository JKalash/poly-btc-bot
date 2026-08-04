/**
 * BPAIR-002 characterization tests — apps/engine PaperExecutor, Accounting,
 * halt idempotency and resolution cross-check.
 *
 * These tests PIN current behavior (spec §25.2 Phase 0). They must fail under
 * deliberate incompatible changes and pass on baseline behavior. Fragile or
 * surprising behavior — notably the single-position-per-market Accounting
 * merge — is characterized exactly and NOT fixed here; spec §6.2 makes that
 * corruption hazard the reason the pair subsystem gets its own ledger.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  auditEvents, healthEvents, makeDb, orderFills, orders as ordersTable,
  positions as positionsTable, resolutions, type DbHandle,
} from "@b5p/db";
import { usdc, type ReferenceTick } from "@b5p/domain";
import type { ParsedFiveMinMarket } from "@b5p/polymarket";
import { eq } from "drizzle-orm";
import { getLocalBus } from "../src/bus";
import { Engine } from "../src/engine";

/** ---- shared fixture (mirrors engine.test.ts) ---- */

const START = 1_785_500_100;
const startEpoch = Math.floor(START / 300) * 300;
const endEpoch = startEpoch + 300;
const NOW0 = (endEpoch - 90) * 1000;

let db: DbHandle;
let engine: Engine;

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

async function warmWorld(nowMs: number): Promise<void> {
  for (let s = 260; s > 0; s--) {
    const ts = nowMs - s * 1000;
    const beforeBoundary = ts <= startEpoch * 1000;
    const noise = 2 * Math.sin(s * 1.3);
    engine.onReferenceTick(tick(ts, (beforeBoundary ? 64000 : 64100) + noise));
    engine.onReferenceTick(tick(ts, (beforeBoundary ? 64000 : 64100) + noise + 4, "binance"));
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

beforeEach(async () => {
  db = await makeDb({ pgliteDir: "memory://", databaseUrl: undefined });
  await db.migrate();
  engine = new Engine(db, getLocalBus(), "paper");
  await engine.start(NOW0 - 1000);
  engine.cfg.strategy.probability_model = "distance_vol_heuristic";
  engine.cfg.strategy.calibration_required = false;
  await engine.upsertDiscoveredMarkets([market()], NOW0 - 1000);
});

afterEach(async () => {
  engine.stop();
  await engine.execTimeline.settle();
  await db.close();
});

/** ---- PaperExecutor taker FAK characterization ---- */

describe("PaperExecutor taker FAK walk", () => {
  it("walks ask levels within the limit with exact per-level USDC fees", async () => {
    await warmWorld(NOW0);
    await seedIntent("d-walk", "i-walk");
    // asks: 400 @ 0.56, 700 @ 0.60, 900 @ 0.65; buy 500 with limit 0.60
    const rec = await engine.paper.submit({
      decisionId: "d-walk", intentId: "i-walk", marketId: "m1", tokenId: "tok-up",
      outcomeSide: "UP", style: "taker_fak",
      price6: 600_000n, shares6: 500_000_000n, stakeCap6: usdc("400"),
      exitPolicy: "hold_to_resolution", nowMs: NOW0, cfg: engine.cfg,
      cancelAtSecondsRemaining: 45, marketEndEpoch: endEpoch,
    });
    await engine.paper.step(NOW0 + 600);

    const row = (await db.db.select().from(ordersTable).where(eq(ordersTable.id, rec.id)))[0]!;
    expect(row.status).toBe("MATCHED");
    expect(row.filledShares6).toBe(500_000_000n);
    expect(row.timeInForce).toBe("FAK");

    // one fill row per touched level, fee = ceil(sh * 0.07 * p * (1-p)) per level
    const fills = (await db.db.select().from(orderFills).where(eq(orderFills.orderId, rec.id)))
      .sort((a, b) => (a.price6 < b.price6 ? -1 : 1));
    expect(fills.length).toBe(2);
    expect(fills[0]).toMatchObject({ price6: 560_000n, shares6: 400_000_000n, feeUsdc6: 6_899_200n, maker: false });
    expect(fills[1]).toMatchObject({ price6: 600_000n, shares6: 100_000_000n, feeUsdc6: 1_680_000n, maker: false });

    // executor spend = sum(ceil-cost + fee) = 224 + 6.8992 + 60 + 1.68 USDC
    expect(rec.spent6).toBe(292_579_200n);

    // accounting mirrors the fills exactly: one position, side UP
    const pos = (await db.db.select().from(positionsTable))[0]!;
    expect(pos).toMatchObject({
      marketId: "m1", outcomeSide: "UP", status: "OPEN",
      shares6: 500_000_000n, cost6: 284_000_000n, fees6: 8_579_200n,
      stake6: 292_579_200n, avgPrice6: 568_000n,
    });
    expect(engine.accounting.state().bankroll).toBe(707_420_800n); // 1000 - 292.5792
  });

  it("PINNED: no FOK semantic exists — partial availability fills partially, remainder canceled", async () => {
    // engine.ts submit path collapses ANY non-maker style to "taker_fak"
    // (style === "maker_post_only" ? "maker_post_only" : "taker_fak"), and
    // PaperOrderRecord's style union has no FOK member. A strategy preset
    // declaring "taker_fok" is therefore executed as FAK by the simulated
    // exchange: fill-what's-there, cancel the rest — never all-or-nothing.
    // The pair subsystem must NOT rely on this path for FOK-per-leg behavior.
    await warmWorld(NOW0);
    await seedIntent("d-fak", "i-fak");
    const rec = await engine.paper.submit({
      decisionId: "d-fak", intentId: "i-fak", marketId: "m1", tokenId: "tok-up",
      outcomeSide: "UP", style: "taker_fak",
      price6: 560_000n, shares6: 2_000_000_000n, // 2000 requested; only 400 within limit
      stakeCap6: usdc("400"), exitPolicy: "hold_to_resolution", nowMs: NOW0,
      cfg: engine.cfg, cancelAtSecondsRemaining: 45, marketEndEpoch: endEpoch,
    });
    await engine.paper.step(NOW0 + 600);
    const row = (await db.db.select().from(ordersTable).where(eq(ordersTable.id, rec.id)))[0]!;
    // a true FOK would kill the whole order; current behavior fills 400 and
    // reports the ORDER as MATCHED even though 1600 shares went unfilled
    expect(row.status).toBe("MATCHED");
    expect(row.filledShares6).toBe(400_000_000n);
    expect(engine.paper.restingOrders().length).toBe(0); // remainder is NOT resting
  });

  it("stake-cap shrink: affordable slice including fee, stepping down 0.01 share on rounding overshoot", async () => {
    await warmWorld(NOW0);
    await seedIntent("d-cap", "i-cap");
    const rec = await engine.paper.submit({
      decisionId: "d-cap", intentId: "i-cap", marketId: "m1", tokenId: "tok-up",
      outcomeSide: "UP", style: "taker_fak",
      price6: 560_000n, shares6: 300_000_000n, // wants 300 sh (~173 USDC) ...
      stakeCap6: usdc("10"),                   // ... but may spend only 10 USDC
      exitPolicy: "hold_to_resolution", nowMs: NOW0, cfg: engine.cfg,
      cancelAtSecondsRemaining: 45, marketEndEpoch: endEpoch,
    });
    await engine.paper.step(NOW0 + 600);

    // Exact characterization of the shrink algebra at level 0.56:
    //   costPerShare6 = breakEvenTakerUsdcCollected(0.56) = 577_248
    //   first candidate floor(10e6 * 1e6 / 577_248) = 17_323_576 micro-shares
    //   -> ceil-cost 9_701_203 + fee 298_798 = 10_000_001 (1 micro OVER budget)
    //   guard loop steps down one 0.01-share notch -> 17_313_576 micro-shares
    //   -> ceil-cost 9_695_603 + fee 298_625 = 9_994_228 <= 10_000_000. PINNED.
    const fills = await db.db.select().from(orderFills).where(eq(orderFills.orderId, rec.id));
    expect(fills.length).toBe(1);
    expect(fills[0]).toMatchObject({ price6: 560_000n, shares6: 17_313_576n, feeUsdc6: 298_625n, maker: false });
    expect(rec.spent6).toBe(9_994_228n);
    expect(rec.spent6 <= rec.stakeCap6).toBe(true);
    // FAK reports MATCHED after a cap-shrunk fill (17 of 300 shares)
    const row = (await db.db.select().from(ordersTable).where(eq(ordersTable.id, rec.id)))[0]!;
    expect(row.status).toBe("MATCHED");
    expect(row.filledShares6).toBe(17_313_576n);
  });

  it("nothing executable within the limit -> CANCELED (not REJECTED), zero fills", async () => {
    await warmWorld(NOW0);
    await seedIntent("d-none", "i-none");
    const rec = await engine.paper.submit({
      decisionId: "d-none", intentId: "i-none", marketId: "m1", tokenId: "tok-up",
      outcomeSide: "UP", style: "taker_fak",
      price6: 500_000n, // best ask is 0.56 -> nothing within limit
      shares6: 10_000_000n, stakeCap6: usdc("10"), exitPolicy: "hold_to_resolution",
      nowMs: NOW0, cfg: engine.cfg, cancelAtSecondsRemaining: 45, marketEndEpoch: endEpoch,
    });
    await engine.paper.step(NOW0 + 600);
    const row = (await db.db.select().from(ordersTable).where(eq(ordersTable.id, rec.id)))[0]!;
    expect(row.status).toBe("CANCELED");
    expect(row.statusReason).toContain("nothing executable");
    expect(row.filledShares6).toBe(0n);
    expect((await db.db.select().from(orderFills)).length).toBe(0);
  });

  it("latency gate: nothing happens before activateAtMs = submit + simulated_latency_ms", async () => {
    await warmWorld(NOW0);
    await seedIntent("d-lat", "i-lat");
    expect(engine.cfg.paper.simulated_latency_ms).toBe(350); // default pinned
    const rec = await engine.paper.submit({
      decisionId: "d-lat", intentId: "i-lat", marketId: "m1", tokenId: "tok-up",
      outcomeSide: "UP", style: "taker_fak",
      price6: 560_000n, shares6: 10_000_000n, stakeCap6: usdc("10"),
      exitPolicy: "hold_to_resolution", nowMs: NOW0, cfg: engine.cfg,
      cancelAtSecondsRemaining: 45, marketEndEpoch: endEpoch,
    });
    expect(rec.status).toBe("PENDING");
    expect(rec.activateAtMs).toBe(NOW0 + 350);
    expect(rec.expireAtMs).toBe(NOW0 + 350 + 2000); // taker FAK gets a 2s expiry window

    await engine.paper.step(NOW0 + 349); // one ms early: still pending
    expect(rec.status).toBe("PENDING");
    expect((await db.db.select().from(orderFills)).length).toBe(0);

    await engine.paper.step(NOW0 + 350); // exactly at activation: executes
    expect(rec.status).toBe("MATCHED");
  });
});

/** ---- post-only activation-time semantics + maker queue ---- */

describe("PaperExecutor post-only and maker queue", () => {
  it("PINNED: would-cross is evaluated at ACTIVATION, not submit — a crossing submit survives if the book moves away", async () => {
    await warmWorld(NOW0);
    await seedIntent("d-mv", "i-mv");
    const rec = await engine.paper.submit({
      decisionId: "d-mv", intentId: "i-mv", marketId: "m1", tokenId: "tok-up",
      outcomeSide: "UP", style: "maker_post_only",
      price6: 570_000n, // CROSSES the 0.56 ask at submit time
      shares6: 10_000_000n, stakeCap6: usdc("10"), exitPolicy: "hold_to_resolution",
      nowMs: NOW0, cfg: engine.cfg, cancelAtSecondsRemaining: 45, marketEndEpoch: endEpoch,
    });
    expect(rec.status).toBe("PENDING"); // NOT rejected at submit
    // book moves away before activation; displayed bid queue exists at 0.57
    engine.onBookSnapshot("tok-up",
      [{ price: "0.57", size: "25" }, { price: "0.55", size: "500" }],
      [{ price: "0.60", size: "700" }],
      NOW0 + 300, NOW0 + 300);
    await engine.paper.step(NOW0 + 600);
    expect(rec.status).toBe("LIVE");
    expect(rec.queueAhead6).toBe(25_000_000n); // joins the BACK of the displayed queue
  });

  it("non-crossing at submit but crossing at activation -> REJECTED safely, never converted to taker", async () => {
    await warmWorld(NOW0);
    await seedIntent("d-x", "i-x");
    const rec = await engine.paper.submit({
      decisionId: "d-x", intentId: "i-x", marketId: "m1", tokenId: "tok-up",
      outcomeSide: "UP", style: "maker_post_only",
      price6: 550_000n, // below the 0.56 ask at submit
      shares6: 10_000_000n, stakeCap6: usdc("10"), exitPolicy: "hold_to_resolution",
      nowMs: NOW0, cfg: engine.cfg, cancelAtSecondsRemaining: 45, marketEndEpoch: endEpoch,
    });
    // ask drops to our price before activation -> now it would cross
    engine.onBookSnapshot("tok-up",
      [{ price: "0.54", size: "100" }],
      [{ price: "0.55", size: "100" }],
      NOW0 + 300, NOW0 + 300);
    await engine.paper.step(NOW0 + 600);
    const row = (await db.db.select().from(ordersTable).where(eq(ordersTable.id, rec.id)))[0]!;
    expect(row.status).toBe("REJECTED");
    expect(row.statusReason).toContain("post-only");
    expect(row.filledShares6).toBe(0n);
    expect((await db.db.select().from(orderFills)).length).toBe(0);
  });

  it("conservative queue model: printed trades consume queue ahead first; maker fills fee-free; pre-activation prints ignored", async () => {
    await warmWorld(NOW0);
    await seedIntent("d-q", "i-q");
    const rec = await engine.paper.submit({
      decisionId: "d-q", intentId: "i-q", marketId: "m1", tokenId: "tok-up",
      outcomeSide: "UP", style: "maker_post_only",
      price6: 550_000n, shares6: 100_000_000n, stakeCap6: usdc("100"),
      exitPolicy: "hold_to_resolution", nowMs: NOW0, cfg: engine.cfg,
      cancelAtSecondsRemaining: 45, marketEndEpoch: endEpoch,
    });
    await engine.paper.step(NOW0 + 600);
    expect(rec.status).toBe("LIVE");
    expect(rec.queueAhead6).toBe(500_000_000n); // displayed 500 at 0.55

    // a print time-stamped BEFORE activateAtMs is ignored entirely
    await engine.paper.onTrade("tok-up", 550_000n, 999_000_000n, NOW0 + 100, "conservative");
    expect(rec.queueAhead6).toBe(500_000_000n);
    expect(rec.filled6).toBe(0n);

    // 300 print at our price: all consumed by the queue ahead, no fill
    await engine.onTrade("tok-up", "0.55", "300", NOW0 + 700);
    expect(rec.queueAhead6).toBe(200_000_000n);
    expect(rec.filled6).toBe(0n);
    expect(rec.status).toBe("LIVE");

    // 400 print: 200 finish the queue, 100 fill us fully (fee-free maker)
    await engine.onTrade("tok-up", "0.55", "400", NOW0 + 800);
    expect(rec.queueAhead6).toBe(0n);
    expect(rec.filled6).toBe(100_000_000n);
    const row = (await db.db.select().from(ordersTable).where(eq(ordersTable.id, rec.id)))[0]!;
    expect(row.status).toBe("MATCHED");
    const fills = await db.db.select().from(orderFills).where(eq(orderFills.orderId, rec.id));
    expect(fills.length).toBe(1);
    expect(fills[0]).toMatchObject({ price6: 550_000n, shares6: 100_000_000n, feeUsdc6: 0n, maker: true });
  });

  it("reconcileOrphans on restart force-cancels PENDING and LIVE orders; terminal orders untouched", async () => {
    await warmWorld(NOW0);
    await seedIntent("d-a", "i-a");
    await seedIntent("d-b", "i-b");
    await seedIntent("d-c", "i-c");
    const args = {
      marketId: "m1", tokenId: "tok-up", outcomeSide: "UP" as const,
      stakeCap6: usdc("100"), exitPolicy: "hold_to_resolution", cfg: engine.cfg,
      cancelAtSecondsRemaining: 45, marketEndEpoch: endEpoch,
    };
    // A: maker that will be LIVE
    const a = await engine.paper.submit({ ...args, decisionId: "d-a", intentId: "i-a", style: "maker_post_only", price6: 550_000n, shares6: 10_000_000n, nowMs: NOW0 });
    // B: taker that will be MATCHED (terminal)
    const b = await engine.paper.submit({ ...args, decisionId: "d-b", intentId: "i-b", style: "taker_fak", price6: 560_000n, shares6: 10_000_000n, nowMs: NOW0 });
    await engine.paper.step(NOW0 + 600);
    // C: submitted after the step -> stays PENDING
    const c = await engine.paper.submit({ ...args, decisionId: "d-c", intentId: "i-c", style: "maker_post_only", price6: 540_000n, shares6: 10_000_000n, nowMs: NOW0 + 700 });
    expect(a.status).toBe("LIVE");
    expect(b.status).toBe("MATCHED");
    expect(c.status).toBe("PENDING");

    // simulate restart: a fresh engine on the same database
    const engine2 = new Engine(db, getLocalBus(), "paper");
    await engine2.start(NOW0 + 5000);
    const byId = new Map((await db.db.select().from(ordersTable)).map((r) => [r.id, r]));
    expect(byId.get(a.id)!.status).toBe("CANCELED");
    expect(byId.get(a.id)!.statusReason).toContain("restart");
    expect(byId.get(c.id)!.status).toBe("CANCELED");
    expect(byId.get(c.id)!.statusReason).toContain("restart");
    expect(byId.get(b.id)!.status).toBe("MATCHED"); // terminal rows are not rewritten
    engine2.stop();
  });
});

/** ---- Accounting: positions keyed by marketId ALONE (corruption hazard) ---- */

describe("Accounting single-position-per-market merge", () => {
  // PINNED CORRUPTION HAZARD (spec §6.2): Accounting.open is a
  // Map<marketId, position>. A second fill for the SAME market with the
  // OPPOSITE outcomeSide does not open a second position — it merges shares
  // and cost into the existing record, whose `side` field silently keeps the
  // FIRST fill's side. Economically different assets (UP vs DOWN tokens)
  // become one blob labeled with the first side. This is exactly why the
  // pair subsystem must own a separate exact inventory ledger and must never
  // reuse the directional `positions` row for both tokens (§7.2).
  it("a DOWN fill on a market with an open UP position merges into the UP record", async () => {
    await engine.accounting.onFill({
      marketId: "m1", decisionId: null, side: "UP", shares6: 10_000_000n,
      price6: 500_000n, fee6: 0n, stake6: usdc("5"), exitPolicy: "hold_to_resolution", nowMs: NOW0,
    });
    await engine.accounting.onFill({
      marketId: "m1", decisionId: null, side: "DOWN", shares6: 10_000_000n,
      price6: 400_000n, fee6: 0n, stake6: usdc("4"), exitPolicy: "some_other_policy", nowMs: NOW0 + 100,
    });

    expect(engine.accounting.state().openPositions).toBe(1); // NOT 2
    expect(engine.accounting.hasOpenPosition("m1")).toBe(true);
    const rows = await db.db.select().from(positionsTable);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      marketId: "m1",
      outcomeSide: "UP",          // the DOWN fill's side identity is LOST
      shares6: 20_000_000n,       // 10 UP + 10 DOWN counted as 20 of one asset
      cost6: 9_000_000n,          // 5 + 4 USDC
      stake6: 9_000_000n,
      avgPrice6: 450_000n,        // half-even(9e6 / 20 shares) — a price of NEITHER leg
      exitPolicy: "hold_to_resolution", // second fill's exit policy ignored
      status: "OPEN",
    });
    expect(engine.accounting.state().bankroll).toBe(usdc("991")); // 1000 - 5 - 4
  });

  it("resolving UP pays the merged DOWN shares as if they were UP winners (overstated P&L)", async () => {
    await engine.accounting.onFill({
      marketId: "m1", decisionId: null, side: "UP", shares6: 10_000_000n,
      price6: 500_000n, fee6: 0n, stake6: usdc("5"), exitPolicy: "hold_to_resolution", nowMs: NOW0,
    });
    await engine.accounting.onFill({
      marketId: "m1", decisionId: null, side: "DOWN", shares6: 10_000_000n,
      price6: 400_000n, fee6: 0n, stake6: usdc("4"), exitPolicy: "hold_to_resolution", nowMs: NOW0 + 100,
    });
    const net = await engine.accounting.onResolution("m1", "UP", NOW0 + 200);
    // TRUE economics: 10 UP shares pay 10, 10 DOWN shares pay 0 -> net +1 USDC.
    // CURRENT behavior: all 20 merged shares pay 1 USDC each -> net +11 USDC,
    // overstating P&L by exactly the DOWN leg's would-be payout (10 USDC).
    expect(net).toBe(usdc("11"));
    expect(engine.accounting.state().bankroll).toBe(usdc("1011"));
    expect(engine.accounting.state().openPositions).toBe(0);
  });

  it("resolving DOWN zeroes BOTH legs — including the DOWN shares that actually won", async () => {
    await engine.accounting.onFill({
      marketId: "m1", decisionId: null, side: "UP", shares6: 10_000_000n,
      price6: 500_000n, fee6: 0n, stake6: usdc("5"), exitPolicy: "hold_to_resolution", nowMs: NOW0,
    });
    await engine.accounting.onFill({
      marketId: "m1", decisionId: null, side: "DOWN", shares6: 10_000_000n,
      price6: 400_000n, fee6: 0n, stake6: usdc("4"), exitPolicy: "hold_to_resolution", nowMs: NOW0 + 100,
    });
    const net = await engine.accounting.onResolution("m1", "DOWN", NOW0 + 200);
    // TRUE economics: DOWN shares pay 10 -> net +1. CURRENT behavior: the
    // merged position is labeled UP, so payout is 0 and the ledger books a
    // full loss of both legs' cost, plus a consecutive-loss increment.
    // (Cost was already deducted at fill time, so the bankroll simply stays
    // at 991 = 1000 - 9 with no payout added back.)
    expect(net).toBe(usdc("-9"));
    expect(engine.accounting.state().bankroll).toBe(usdc("991"));
    expect(engine.accounting.state().consecutiveLosses).toBe(1);
  });
});

/** ---- halt idempotency and resolution cross-check ---- */

describe("engine halt and resolution cross-check", () => {
  it("halt is idempotent: the second call is a complete no-op", async () => {
    await engine.halt("first reason", NOW0);
    expect(engine.engineState).toBe("HALTED");
    const audits1 = (await db.db.select().from(auditEvents)).filter((a) => a.action === "halt");
    const health1 = (await db.db.select().from(healthEvents)).filter((h) => h.kind === "halt");
    expect(audits1.length).toBe(1);
    expect(health1.length).toBe(1);

    await engine.halt("second reason", NOW0 + 1000); // must not double-record
    expect(engine.engineState).toBe("HALTED");
    const audits2 = (await db.db.select().from(auditEvents)).filter((a) => a.action === "halt");
    const health2 = (await db.db.select().from(healthEvents)).filter((h) => h.kind === "halt");
    expect(audits2.length).toBe(1);
    expect(health2.length).toBe(1);
    expect((audits2[0]!.data as { reason: string }).reason).toBe("first reason"); // first reason wins
  });

  it("resolution cross-check mismatch (local vs official) triggers halt and flags the resolution row", async () => {
    await warmWorld(NOW0);
    await engine.step(NOW0); // captures price-to-beat ~64000
    engine.onReferenceTick(tick(endEpoch * 1000 - 200, 64100));
    await engine.step(endEpoch * 1000 + 4000); // local resolution: UP

    let res = await db.db.select().from(resolutions);
    expect(res.length).toBe(1);
    expect(res[0]!.outcome).toBe("UP");
    expect(res[0]!.mismatch).toBe(false);
    expect(engine.engineState).not.toBe("HALTED");

    // official outcome arrives via discovery refresh and says DOWN
    await engine.upsertDiscoveredMarkets(
      [market({ closed: true, outcomePrices: [0.001, 0.999] })],
      endEpoch * 1000 + 5000,
    );
    expect(engine.engineState).toBe("HALTED");
    res = await db.db.select().from(resolutions);
    expect(res[0]!.mismatch).toBe(true);
    expect(res[0]!.officialOutcome).toBe("DOWN");
  });

  it("matching official outcome reconciles without halting", async () => {
    await warmWorld(NOW0);
    await engine.step(NOW0);
    engine.onReferenceTick(tick(endEpoch * 1000 - 200, 64100));
    await engine.step(endEpoch * 1000 + 4000);

    await engine.upsertDiscoveredMarkets(
      [market({ closed: true, outcomePrices: [0.999, 0.001] })],
      endEpoch * 1000 + 5000,
    );
    expect(engine.engineState).toBe("PAPER");
    const res = await db.db.select().from(resolutions);
    expect(res[0]!.mismatch).toBe(false);
    expect(res[0]!.officialOutcome).toBe("UP");
  });
});

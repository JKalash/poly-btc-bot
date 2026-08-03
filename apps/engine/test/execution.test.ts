import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  executionTimelineEvents, fillCounterfactuals, fillSelectionCostRecords, latencySamples,
  makeDb, markoutObservations, orderAttempts, orderbookSnapshots, orders as ordersTable,
  paperVariantResults, pnlRecords, queueEstimates, type DbHandle,
} from "@b5p/db";
import { usdc, type ReferenceTick } from "@b5p/domain";
import type { ParsedFiveMinMarket } from "@b5p/polymarket";
import { BookState } from "@b5p/strategy";
import { getLocalBus } from "../src/bus";
import { Engine } from "../src/engine";
import { IntentExecutionGuard } from "../src/execution-invariants";
import { ExecutionPersistence } from "../src/execution-persistence";
import { FillCounterfactualRecorder, MarkoutSampler } from "../src/markout";

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

beforeEach(async () => {
  db = await makeDb({ pgliteDir: "memory://", databaseUrl: undefined });
  await db.migrate();
  engine = new Engine(db, getLocalBus(), "paper");
  await engine.start(NOW0 - 1000);
  engine.cfg.strategy.probability_model = "distance_vol_heuristic";
  // The heuristic model is UNCALIBRATED: with the (default) calibration_required
  // gate enforced it can never be approved, so these tests opt out explicitly.
  engine.cfg.strategy.calibration_required = false;
  await engine.upsertDiscoveredMarkets([market()], NOW0 - 1000);
});

afterEach(async () => {
  engine.stop();
  await engine.execTimeline.settle();
  await db.close();
});

/** ---- execution timeline through the full paper lifecycle ---- */

describe("execution timeline in the paper decision path", () => {
  it("emits ordered timeline events with four distinguishable book snapshots, queue estimates, and partial fills reducing authorized size", async () => {
    await warmWorld(NOW0);
    await engine.step(NOW0); // decision + submit (decision/send snapshots at NOW0 book)

    const ors = await db.db.select().from(ordersTable);
    expect(ors.length).toBe(1);
    const order = ors[0]!;
    const shares6 = order.shares6;

    // change the book BEFORE activation so the ack snapshot content differs
    const t1 = NOW0 + 600;
    engine.onReferenceTick(tick(t1 - 100, 64100));
    engine.onBookSnapshot("tok-up",
      [{ price: "0.55", size: "480" }, { price: "0.50", size: "800" }],
      [{ price: "0.56", size: "390" }, { price: "0.60", size: "700" }, { price: "0.65", size: "900" }],
      t1 - 50, t1 - 50);
    await engine.step(t1); // activation -> EXCHANGE_ACK + RESTING

    // change the book again before the fills so the fill snapshot differs too
    engine.onBookSnapshot("tok-up",
      [{ price: "0.55", size: "470" }, { price: "0.50", size: "790" }],
      [{ price: "0.56", size: "380" }, { price: "0.60", size: "700" }, { price: "0.65", size: "900" }],
      t1 + 50, t1 + 50);

    // PARTIAL fill: 490 shares print at our level — 480 consumed by the queue
    // ahead (displayed size at activation), 10 fill us
    const restingPrice = (Number(order.price6) / 1e6).toFixed(2);
    await engine.onTrade("tok-up", restingPrice, "490", t1 + 100);
    await engine.execTimeline.settle();

    let attempts = await db.db.select().from(orderAttempts);
    expect(attempts.length).toBe(1);
    expect(attempts[0]!.size6).toBe(shares6);
    // invariant: partial fill reduces the authorized remaining size
    expect(attempts[0]!.remaining6).toBe(shares6 - 10_000_000n);
    expect(attempts[0]!.status).toBe("PARTIAL_FILL");

    // complete the fill
    await engine.onTrade("tok-up", restingPrice, "2000", t1 + 200);
    await engine.step(t1 + 400);
    await engine.execTimeline.settle();

    attempts = await db.db.select().from(orderAttempts);
    const a = attempts[0]!;
    expect(a.remaining6).toBe(0n);
    expect(a.status).toBe("FILLED");
    expect(a.requestHash.length).toBe(64);
    expect(a.attemptNumber).toBe(1);

    // four book snapshot refs: all present, all distinct rows
    const snapIds = [a.decisionBookSnapshotId, a.sendBookSnapshotId, a.ackBookSnapshotId, a.fillBookSnapshotId];
    for (const id of snapIds) expect(id).not.toBeNull();
    expect(new Set(snapIds.map((i) => i!.toString())).size).toBe(4);
    // decision vs ack snapshots captured different books (sizes changed)
    const snaps = await db.db.select().from(orderbookSnapshots);
    const decisionSnap = snaps.find((s) => s.id === a.decisionBookSnapshotId)!;
    const ackSnap = snaps.find((s) => s.id === a.ackBookSnapshotId)!;
    const fillSnap = snaps.find((s) => s.id === a.fillBookSnapshotId)!;
    expect(JSON.stringify(decisionSnap.bids)).not.toBe(JSON.stringify(ackSnap.bids));
    expect(JSON.stringify(ackSnap.bids)).not.toBe(JSON.stringify(fillSnap.bids));

    // ordered timeline with monotonic clocks
    const events = await db.db.select().from(executionTimelineEvents);
    const seq = events
      .map((e) => ({ state: e.state, seq: (e.detail as { seq: number }).seq, monoNs: e.monoNs, mode: e.mode }))
      .sort((x, y) => x.seq - y.seq);
    expect(seq.map((e) => e.state)).toEqual([
      "DECISION_SNAPSHOT", "INTENT_CREATED", "RISK_APPROVED", "SIGN_STARTED", "SENT",
      "EXCHANGE_ACK", "RESTING", "PARTIAL_FILL", "FILLED",
    ]);
    for (const e of seq) expect(e.mode).toBe("PAPER");
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]!.monoNs! > seq[i - 1]!.monoNs!).toBe(true);
    }

    // queue estimate captured at activation (conservative full-level join)
    const qs = await db.db.select().from(queueEstimates);
    expect(qs.length).toBeGreaterThanOrEqual(1);
    expect(qs[0]!.method).toBe("FULL_LEVEL_CONSERVATIVE");
    expect(qs[0]!.attemptId).toBe(a.id);

    // latency samples: BOOK_FEED at decision + SEND around paper submit
    const lat = await db.db.select().from(latencySamples);
    const stages = new Set(lat.map((l) => l.stage));
    expect(stages.has("BOOK_FEED")).toBe(true);
    expect(stages.has("SEND")).toBe(true);
  });

  it("post-only crossing at activation is a safe no-fill routed to the timeline as REJECTED", async () => {
    await warmWorld(NOW0);
    await engine.step(NOW0);
    const order = (await db.db.select().from(ordersTable))[0]!;

    // before activation, the ask collapses to our price -> post-only would cross
    const t1 = NOW0 + 600;
    engine.onReferenceTick(tick(t1 - 100, 64100));
    engine.onBookSnapshot("tok-up",
      [{ price: "0.50", size: "100" }],
      [{ price: (Number(order.price6) / 1e6).toFixed(2), size: "100" }],
      t1 - 50, t1 - 50);
    await engine.step(t1);
    await engine.execTimeline.settle();

    const row = (await db.db.select().from(ordersTable))[0]!;
    expect(row.status).toBe("REJECTED");
    expect(row.filledShares6).toBe(0n);

    const events = await db.db.select().from(executionTimelineEvents);
    const rejected = events.filter((e) => e.state === "REJECTED");
    expect(rejected.length).toBe(1);
    expect(String((rejected[0]!.detail as { reason?: string }).reason)).toContain("post-only");
    // never a fill event
    expect(events.some((e) => e.state === "PARTIAL_FILL" || e.state === "FILLED")).toBe(false);
    const attempts = await db.db.select().from(orderAttempts);
    expect(attempts[0]!.status).toBe("REJECTED");
  });

  it("resolution persists all three paper variants (pnl6 NET of fees), fill-selection cost, markouts, and reconciles the timeline", async () => {
    await warmWorld(NOW0);
    await engine.step(NOW0);
    const t1 = NOW0 + 600;
    engine.onReferenceTick(tick(t1 - 100, 64100));
    await engine.step(t1);
    const order = (await db.db.select().from(ordersTable))[0]!;
    const restingPrice = (Number(order.price6) / 1e6).toFixed(2);
    await engine.onTrade("tok-up", restingPrice, "2000", t1 + 100);

    // fresh book AFTER the fill so horizon markouts become observable
    engine.onBookSnapshot("tok-up",
      [{ price: "0.55", size: "460" }],
      [{ price: "0.56", size: "370" }],
      t1 + 200, t1 + 200);
    await engine.step(t1 + 400); // 250ms markout due at fill+250

    // resolve UP (win)
    engine.onReferenceTick(tick(endEpoch * 1000 - 200, 64100));
    await engine.step(endEpoch * 1000 + 4000);
    await engine.execTimeline.settle();

    const pnl = await db.db.select().from(pnlRecords);
    expect(pnl.length).toBe(1);

    const variants = await db.db.select().from(paperVariantResults);
    expect(variants.length).toBe(3);
    const byVariant = Object.fromEntries(variants.map((v) => [v.variant, v]));
    const qr = byVariant.QUEUE_REPLAY!;
    const opt = byVariant.OPTIMISTIC_TOUCH!;
    const stress = byVariant.CONSERVATIVE_STRESS!;

    // QUEUE_REPLAY === the canonical pnl path, bit for bit (pnl6 net of fees)
    expect(qr.filled).toBe(true);
    expect(qr.fillSize6).toBe(order.shares6);
    expect(qr.pnl6).toBe(pnl[0]!.net6);
    expect(qr.fee6).toBe(pnl[0]!.fees6);

    // OPTIMISTIC_TOUCH fills fully at the touch
    expect(opt.filled).toBe(true);
    expect(opt.fillSize6).toBe(order.shares6);

    // CONSERVATIVE_STRESS never fills better than QUEUE_REPLAY
    expect(stress.fillSize6 <= qr.fillSize6).toBe(true);
    if (stress.filled) {
      expect(stress.fillPrice6 >= qr.fillPrice6).toBe(true);
      expect(stress.pnl6! <= qr.pnl6!).toBe(true); // won market: fewer shares at worse price
    }

    // correlation id threads decision -> variant rows (dashboard join contract)
    const { decisionSnapshots } = await import("@b5p/db");
    const ds = (await db.db.select().from(decisionSnapshots))[0]!;
    for (const v of variants) expect(v.correlationId).toBe(ds.correlationId);

    // fill-selection cost computed on the resolution batch
    const fsc = await db.db.select().from(fillSelectionCostRecords);
    expect(fsc.length).toBe(1);
    expect(fsc[0]!.signalSampleCount).toBeGreaterThanOrEqual(1);
    expect(fsc[0]!.fillSampleCount).toBeGreaterThanOrEqual(1);
    expect(fsc[0]!.cost6).toBe(fsc[0]!.signalConditionedValue6 - fsc[0]!.fillConditionedValue6);

    // markouts: at least one horizon row (book newer than fill) + AT_RESOLUTION
    const mo = await db.db.select().from(markoutObservations);
    const horizonRows = mo.filter((m) => m.horizonMs !== "AT_RESOLUTION");
    const resolutionRows = mo.filter((m) => m.horizonMs === "AT_RESOLUTION");
    expect(horizonRows.length).toBeGreaterThanOrEqual(1);
    expect(resolutionRows.length).toBeGreaterThanOrEqual(1);
    for (const m of mo) expect(m.correlationId).toBe(ds.correlationId);
    // winning BUY settled at 1.0: AT_RESOLUTION markout is positive
    expect(resolutionRows[0]!.midAtHorizon6).toBe(1_000_000n);
    expect(resolutionRows[0]!.markout6 > 0n).toBe(true);

    // timeline reconciled after resolution (terminal state)
    const events = await db.db.select().from(executionTimelineEvents);
    const states = events.map((e) => e.state);
    expect(states).toContain("BALANCE_RECONCILED");
  });
});

/** ---- invariant guards (pure logic) ---- */

describe("intent execution guard invariants", () => {
  const base = { intentId: "i1", decisionId: "d1", correlationId: "c1", approvedShares6: 100_000_000n, entryCutoffMs: 10_000 };

  it("partial fills reduce the authorized size for retries", () => {
    const g = new IntentExecutionGuard(base);
    expect(g.authorizeAttempt(100_000_000n, 0).ok).toBe(true);
    g.recordFill(40_000_000n);
    expect(g.remaining6()).toBe(60_000_000n);
    expect(g.authorizeAttempt(70_000_000n, 0).ok).toBe(false); // exceeds remaining
    expect(g.authorizeAttempt(60_000_000n, 0).ok).toBe(true);
  });

  it("duplicate exchange ack does not create duplicate exposure", () => {
    const g = new IntentExecutionGuard(base);
    expect(g.registerAck("hash-1")).toBe(true);
    expect(g.registerAck("hash-1")).toBe(false); // idempotent replay
    // even a buggy double fill cannot exceed the approved size
    g.recordFill(100_000_000n);
    const second = g.recordFill(100_000_000n);
    expect(second.accepted6).toBe(0n);
    expect(second.clamped).toBe(true);
    expect(g.totalFilled6()).toBe(100_000_000n);
  });

  it("cancel/ack uncertainty blocks any replacement until balance reconciliation", () => {
    const g = new IntentExecutionGuard(base);
    g.markUnknownOutcome();
    expect(g.authorizeAttempt(1_000_000n, 0).refusal).toBe("UNKNOWN_OUTCOME_UNRECONCILED");
    expect(g.beginMutation("a2").ok).toBe(false);
    g.markBalanceReconciled();
    expect(g.authorizeAttempt(1_000_000n, 0).ok).toBe(true);
  });

  it("no attempt is authorized at or past the entry cutoff", () => {
    const g = new IntentExecutionGuard(base);
    expect(g.authorizeAttempt(1_000_000n, 9_999).ok).toBe(true);
    expect(g.authorizeAttempt(1_000_000n, 10_000).refusal).toBe("PAST_ENTRY_CUTOFF");
  });

  it("one in-flight mutation per intent", () => {
    const g = new IntentExecutionGuard(base);
    expect(g.beginMutation("a1").ok).toBe(true);
    expect(g.beginMutation("a2").refusal).toBe("MUTATION_IN_FLIGHT");
    g.endMutation("a1");
    expect(g.beginMutation("a2").ok).toBe(true);
  });

  it("PROPERTY: no retry/partial-fill combination ever exceeds the approved stake", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 1_000_000_000n }),
        fc.array(
          fc.record({
            kind: fc.constantFrom("authorize", "fill", "unknown", "reconcile"),
            size: fc.bigInt({ min: 0n, max: 2_000_000_000n }),
          }),
          { maxLength: 60 },
        ),
        (approved, ops) => {
          const g = new IntentExecutionGuard({ ...base, approvedShares6: approved, entryCutoffMs: Number.MAX_SAFE_INTEGER });
          for (const op of ops) {
            if (op.kind === "authorize") {
              const r = g.authorizeAttempt(op.size, 0);
              if (r.ok) {
                // an authorized attempt never exceeds what is still approved
                expect(op.size <= approved - g.totalFilled6()).toBe(true);
              }
            } else if (op.kind === "fill") {
              g.recordFill(op.size);
            } else if (op.kind === "unknown") {
              g.markUnknownOutcome();
              expect(g.authorizeAttempt(1n, 0).ok).toBe(false); // quarantined
            } else {
              g.markBalanceReconciled();
            }
            expect(g.totalFilled6() <= approved).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

/** ---- markout sampler: only books AFTER the fill ---- */

describe("markout sampler", () => {
  it("only samples books strictly newer than the fill timestamp, and drops unobservable markouts", async () => {
    const persistence = new ExecutionPersistence(db);
    const book = new BookState("tokX");
    const T = 1_785_500_000_000;
    book.applySnapshot([{ price: "0.50", size: "100" }], [{ price: "0.52", size: "100" }], T - 1000, T - 1000); // mid 0.51 BEFORE fill
    const sampler = new MarkoutSampler(persistence, () => book, () => [250, 1000], () => 1);

    sampler.registerFill({
      correlationId: "c-mo", attemptId: null, fillId: null, marketId: "mX", tokenId: "tokX",
      side: "BUY", fillTsMs: T, midAtFill6: 510_000n,
    });

    // horizon due, but the only book known predates the fill -> nothing emitted
    expect(sampler.sample(T + 300)).toBe(0);
    let rows = await drain(persistence, markoutObservations);
    expect(rows.length).toBe(0);

    // book updates AFTER the fill -> the pending 250ms markout becomes observable
    book.applySnapshot([{ price: "0.53", size: "100" }], [{ price: "0.55", size: "100" }], T + 100, T + 100); // mid 0.54
    expect(sampler.sample(T + 350)).toBe(1);
    rows = await drain(persistence, markoutObservations);
    expect(rows.length).toBe(1);
    expect(rows[0]!.horizonMs).toBe("250");
    expect(rows[0]!.midAtHorizon6).toBe(540_000n); // the post-fill book, never the stale one
    expect(rows[0]!.markout6).toBe(30_000n); // BUY: mid moved up in our favor

    // second fill whose book never updates: dropped after grace, never fabricated
    const T2 = T + 100_000;
    sampler.registerFill({
      correlationId: "c-mo2", attemptId: null, fillId: null, marketId: "mX", tokenId: "tokX",
      side: "BUY", fillTsMs: T2, midAtFill6: 510_000n,
    });
    expect(sampler.sample(T2 + 250 + 31_000)).toBe(0);
    expect(sampler.sample(T2 + 1000 + 31_000)).toBe(0);
    expect(sampler.pendingCount()).toBe(0);
    rows = await drain(persistence, markoutObservations);
    expect(rows.length).toBe(1); // unchanged
  });

  it("AT_RESOLUTION markout settles the winning side at 1.0", async () => {
    const persistence = new ExecutionPersistence(db);
    const book = new BookState("tokX");
    const T = 1_785_500_000_000;
    const sampler = new MarkoutSampler(persistence, () => book, () => [250], () => 1);
    sampler.registerFill({
      correlationId: "c-res", attemptId: null, fillId: null, marketId: "mX", tokenId: "tokX",
      side: "BUY", fillTsMs: T, midAtFill6: 600_000n,
    });
    expect(sampler.onResolution("mX", "UP", () => "UP", T + 5000)).toBe(1);
    const rows = await drain(persistence, markoutObservations);
    expect(rows.length).toBe(1);
    expect(rows[0]!.horizonMs).toBe("AT_RESOLUTION");
    expect(rows[0]!.midAtHorizon6).toBe(1_000_000n);
    expect(rows[0]!.markout6).toBe(400_000n);
  });
});

/** ---- fill counterfactuals ---- */

describe("fill counterfactual recorder", () => {
  it("records a would-be maker fill with trade-tape evidence for an order we never placed", async () => {
    const persistence = new ExecutionPersistence(db);
    const rec = new FillCounterfactualRecorder(persistence, () => 1, () => true);
    const T = 1_785_500_000_000;
    rec.register({
      correlationId: "c-cf", decisionId: "d-cf", marketId: "mX", tokenId: "tokX",
      price6: 550_000n, size6: 100_000_000n, reason: "shadow_not_placed",
      queueAhead6: 50_000_000n, registeredAtMs: T, expiresAtMs: T + 60_000,
    });
    // first print eats the queue ahead, second would fill us
    rec.onTrade("tokX", 550_000n, 50_000_000n, T + 1000);
    rec.onTrade("tokX", 540_000n, 80_000_000n, T + 2000);
    rec.onTrade("tokX", 560_000n, 500_000_000n, T + 3000); // above our price: no effect
    expect(rec.expire(T + 61_000)).toBe(1);
    const rows = await drain(persistence, fillCounterfactuals);
    expect(rows.length).toBe(1);
    expect(rows[0]!.wouldFill).toBe(true);
    expect(rows[0]!.reason).toBe("shadow_not_placed");
    const ev = rows[0]!.evidence as { wouldFillShares6: string; trades: unknown[] };
    expect(ev.wouldFillShares6).toBe("80000000");
    expect(ev.trades.length).toBe(2);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function drain(persistence: ExecutionPersistence, table: any): Promise<any[]> {
  await persistence.settle();
  return db.db.select().from(table);
}

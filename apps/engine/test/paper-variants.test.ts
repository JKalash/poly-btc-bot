import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@b5p/config";
import {
  decisionSnapshots, makeDb, orderFills, orderIntents, paperVariantResults, type DbHandle,
} from "@b5p/db";
import { BookState } from "@b5p/strategy";
import { DEFAULT_STRESS_PARAMS, type StressParams } from "../src/execution-constants";
import { ExecutionPersistence } from "../src/execution-persistence";
import { PaperVariantEngine, SeededRng } from "../src/paper-variants";
import { PaperExecutor, type FillEvent } from "../src/paper";

/**
 * Plan 1c: three-variant paper fill simulation.
 *
 * The QUEUE_REPLAY regression fixture below locks the canonical paper
 * executor's arithmetic bit-for-bit (goldens generated from the pre-refactor
 * logic — the refactor deliberately left this path untouched, and this test
 * keeps it that way).
 */

const NOW = 1_785_500_000_000;
const END_EPOCH = Math.floor(NOW / 1000) + 300;

let db: DbHandle;
let book: BookState;
let persistence: ExecutionPersistence;
let variants: PaperVariantEngine;
let px: PaperExecutor;
let fills: FillEvent[];
let stressParams: StressParams;

function resetBook(): void {
  book.applySnapshot(
    [{ price: "0.55", size: "500" }],
    [{ price: "0.56", size: "400" }, { price: "0.60", size: "700" }],
    NOW, NOW,
  );
}

beforeEach(async () => {
  db = await makeDb({ pgliteDir: "memory://", databaseUrl: undefined });
  await db.migrate();
  book = new BookState("tok");
  resetBook();
  stressParams = { ...DEFAULT_STRESS_PARAMS };
  persistence = new ExecutionPersistence(db);
  variants = new PaperVariantEngine(persistence, () => stressParams, () => 1);
  fills = [];
  px = new PaperExecutor(
    db,
    () => 70_000n,
    () => "usdc",
    async (f) => {
      fills.push(f);
      variants.onActualFill(f.order, f.shares6, f.price6, f.fee6, f.tsMs);
    },
    () => book,
  );
  px.hooks = {
    onActivated: (o, nowMs) => variants.onOrderActivated(o.id, nowMs),
    onFinished: (o, status, _reason, nowMs) => variants.onOrderFinished(o.id, status, nowMs),
  };
});

afterEach(async () => {
  await persistence.settle();
  await db.close();
});

let seedCount = 0;
async function seedIntent(): Promise<{ decisionId: string; intentId: string; correlationId: string }> {
  const n = ++seedCount;
  const decisionId = `d${n}`;
  const intentId = `i${n}`;
  const correlationId = `corr${n}`;
  await db.db.insert(decisionSnapshots).values({
    decisionId, marketId: "m1", mode: "paper", correlationId, data: {}, createdAtMs: NOW,
  }).onConflictDoNothing();
  await db.db.insert(orderIntents).values({
    id: intentId, decisionId, version: 1, idempotencyKey: `k${n}`, payload: {}, createdAtMs: NOW,
  });
  return { decisionId, intentId, correlationId };
}

async function submitMaker(correlationId: string, ids: { decisionId: string; intentId: string }) {
  const rec = await px.submit({
    decisionId: ids.decisionId, intentId: ids.intentId, marketId: "m1", tokenId: "tok",
    outcomeSide: "UP", style: "maker_post_only", price6: 550_000n, shares6: 250_000_000n,
    stakeCap6: 200_000_000n, exitPolicy: "hold_to_resolution", nowMs: NOW, cfg: DEFAULT_CONFIG,
    cancelAtSecondsRemaining: 45, marketEndEpoch: END_EPOCH,
  });
  variants.onOrderSubmitted(rec, { correlationId, tickSize6: 10_000n, feeRatePpm: 70_000n, feeCollection: "usdc" });
  return rec;
}

describe("QUEUE_REPLAY bit-identical regression (golden fixture)", () => {
  it("maker queue-consumption fills are exactly the pre-refactor goldens", async () => {
    const ids = await seedIntent();
    const rec = await submitMaker(ids.correlationId, ids);
    await px.step(NOW + 400); // activate (350ms simulated latency)

    await px.onTrade("tok", 550_000n, 300_000_000n, NOW + 900, "conservative");  // queue 500 -> 200, no fill
    await px.onTrade("tok", 540_000n, 400_000_000n, NOW + 1000, "conservative"); // queue drained, fill 200
    await px.onTrade("tok", 550_000n, 100_000_000n, NOW + 1100, "conservative"); // fill remaining 50

    expect(rec.status).toBe("MATCHED");
    expect(rec.filled6).toBe(250_000_000n);
    expect(rec.spent6).toBe(137_500_000n);
    const rows = (await db.db.select().from(orderFills)).filter((f) => f.orderId === rec.id);
    expect(rows.map((f) => [f.shares6, f.price6, f.feeUsdc6, f.maker, f.tsMs])).toEqual([
      [200_000_000n, 550_000n, 0n, true, 1_785_500_001_000],
      [50_000_000n, 550_000n, 0n, true, 1_785_500_001_100],
    ]);

    // the QUEUE_REPLAY variant mirrors the canonical fills verbatim
    variants.onResolution("m1", "UP", NOW + 5000);
    await persistence.settle();
    const vr = (await db.db.select().from(paperVariantResults)).filter((v) => v.decisionId === ids.decisionId);
    const qr = vr.find((v) => v.variant === "QUEUE_REPLAY")!;
    expect(qr.fillSize6).toBe(250_000_000n);
    expect(qr.fillPrice6).toBe(550_000n);
    expect(qr.fee6).toBe(0n);
    // pnl6 is NET of fees: payout 250 - cost 137.5 - fees 0
    expect(qr.pnl6).toBe(112_500_000n);
  });

  it("taker FAK walk and stake-cap shrink are exactly the pre-refactor goldens", async () => {
    const clean = await seedIntent();
    const taker = await px.submit({
      decisionId: clean.decisionId, intentId: clean.intentId, marketId: "m1", tokenId: "tok",
      outcomeSide: "UP", style: "taker_fak", price6: 600_000n, shares6: 500_000_000n,
      stakeCap6: 300_000_000n, exitPolicy: "hold_to_resolution", nowMs: NOW + 2000, cfg: DEFAULT_CONFIG,
      cancelAtSecondsRemaining: 45, marketEndEpoch: END_EPOCH,
    });
    await px.step(NOW + 2400);
    expect(taker.status).toBe("MATCHED");
    expect(taker.filled6).toBe(500_000_000n);
    expect(taker.spent6).toBe(292_579_200n);
    const takerFills = (await db.db.select().from(orderFills)).filter((f) => f.orderId === taker.id);
    expect(takerFills.map((f) => [f.shares6, f.price6, f.feeUsdc6])).toEqual([
      [400_000_000n, 560_000n, 6_899_200n],
      [100_000_000n, 600_000n, 1_680_000n],
    ]);

    // cap-binding shrink path (fee-inclusive cost per share)
    resetBook();
    const capped = await seedIntent();
    const cappedRec = await px.submit({
      decisionId: capped.decisionId, intentId: capped.intentId, marketId: "m1", tokenId: "tok",
      outcomeSide: "UP", style: "taker_fak", price6: 600_000n, shares6: 500_000_000n,
      stakeCap6: 100_000_000n, exitPolicy: "hold_to_resolution", nowMs: NOW + 3000, cfg: DEFAULT_CONFIG,
      cancelAtSecondsRemaining: 45, marketEndEpoch: END_EPOCH,
    });
    await px.step(NOW + 3400);
    expect(cappedRec.status).toBe("MATCHED");
    expect(cappedRec.filled6).toBe(173_235_766n);
    expect(cappedRec.spent6).toBe(100_000_000n); // exactly the cap, never above
    const cappedFills = (await db.db.select().from(orderFills)).filter((f) => f.orderId === cappedRec.id);
    expect(cappedFills.map((f) => [f.shares6, f.price6, f.feeUsdc6])).toEqual([
      [173_235_766n, 560_000n, 2_987_971n],
    ]);
  });
});

describe("OPTIMISTIC_TOUCH", () => {
  it("fills the maker order fully at its price the moment it activates at the touch", async () => {
    const ids = await seedIntent();
    await submitMaker(ids.correlationId, ids);
    await px.step(NOW + 400); // activation: optimistic fills NOW; no trades ever print
    variants.onResolution("m1", "UP", NOW + 5000);
    await persistence.settle();
    const vr = (await db.db.select().from(paperVariantResults)).filter((v) => v.decisionId === ids.decisionId);
    const opt = vr.find((v) => v.variant === "OPTIMISTIC_TOUCH")!;
    const qr = vr.find((v) => v.variant === "QUEUE_REPLAY")!;
    expect(opt.filled).toBe(true);
    expect(opt.fillSize6).toBe(250_000_000n);
    expect(opt.fillPrice6).toBe(550_000n);
    expect(opt.pnl6).toBe(112_500_000n); // net of (zero) fees
    // queue replay saw no prints -> unfilled, zero P&L; variants are NEVER merged
    expect(qr.filled).toBe(false);
    expect(qr.fillSize6).toBe(0n);
    expect(qr.pnl6).toBe(0n);
  });
});

describe("CONSERVATIVE_STRESS", () => {
  it("is deterministic for a given correlation id (seeded RNG, no Math.random)", async () => {
    const results: Array<{ size: bigint; price: bigint; pnl: bigint | null }> = [];
    for (let run = 0; run < 2; run++) {
      const p = new ExecutionPersistence(db);
      const v = new PaperVariantEngine(p, () => stressParams, () => 1);
      const fakeOrder = {
        id: `o-run${run}`, decisionId: `dd-run${run}`, intentId: "x", marketId: `mm-${run}`, tokenId: "tok",
        outcomeSide: "UP" as const, style: "maker_post_only" as const, price6: 550_000n,
        shares6: 250_000_000n, filled6: 0n, queueAhead6: 0n, stakeCap6: 200_000_000n, spent6: 0n,
        status: "LIVE" as const, activateAtMs: NOW + 350, expireAtMs: null, exitPolicy: "hold", createdAtMs: NOW,
      };
      v.onOrderSubmitted(fakeOrder, { correlationId: "SAME-SEED", tickSize6: 10_000n, feeRatePpm: 70_000n, feeCollection: "usdc" });
      v.onOrderActivated(fakeOrder.id, NOW + 350);
      // identical fill stream, well past the stress latency window
      for (let i = 0; i < 8; i++) v.onActualFill(fakeOrder, 25_000_000n, 550_000n, 0n, NOW + 1000 + i * 100);
      v.onResolution(`mm-${run}`, "UP", NOW + 5000);
      await p.settle();
      const row = (await db.db.select().from(paperVariantResults))
        .find((r) => r.decisionId === `dd-run${run}` && r.variant === "CONSERVATIVE_STRESS")!;
      results.push({ size: row.fillSize6, price: row.fillPrice6, pnl: row.pnl6 });
    }
    expect(results[0]).toEqual(results[1]);
  });

  it("never fills better than QUEUE_REPLAY across many seeds (subset of fills, one tick worse)", async () => {
    for (let n = 0; n < 8; n++) {
      resetBook();
      const ids = await seedIntent();
      const rec = await submitMaker(ids.correlationId, ids);
      await px.step(NOW + 400);
      // trades straddle the stress latency window: some only queue-replay can catch
      await px.onTrade("tok", 550_000n, 300_000_000n, NOW + 500, "conservative"); // queue only
      await px.onTrade("tok", 550_000n, 250_000_000n, NOW + 700, "conservative"); // before stress activation
      await px.onTrade("tok", 540_000n, 120_000_000n, NOW + 1000, "conservative");
      await px.onTrade("tok", 550_000n, 90_000_000n, NOW + 1200, "conservative");
      if (rec.status !== "MATCHED") await px.cancel(rec.id, "test cancel", NOW + 2000);
      variants.onResolution("m1", "UP", NOW + 5000);
    }
    await persistence.settle();
    const rows = await db.db.select().from(paperVariantResults);
    for (let n = 1; n <= seedCount; n++) {
      const qr = rows.find((r) => r.decisionId === `d${n}` && r.variant === "QUEUE_REPLAY");
      const stress = rows.find((r) => r.decisionId === `d${n}` && r.variant === "CONSERVATIVE_STRESS");
      if (!qr || !stress) continue;
      expect(stress.fillSize6 <= qr.fillSize6).toBe(true);
      if (stress.filled) {
        expect(qr.filled).toBe(true);
        expect(stress.fillPrice6 >= qr.fillPrice6 + 10_000n).toBe(true); // one full tick worse
      }
      // same (winning) outcome: degraded fills can never out-earn queue replay
      expect((stress.pnl6 ?? 0n) <= (qr.pnl6 ?? 0n)).toBe(true);
    }
  });

  it("failed cancels are charged as an adverse penalty without granting shares", async () => {
    // force every cancel to fail and every fill to be missed
    stressParams = { ...stressParams, missedFillFraction: 1, cancelFailFraction: 1 };
    const ids = await seedIntent();
    const rec = await submitMaker(ids.correlationId, ids);
    await px.step(NOW + 400);
    // queue 500 consumed + 100 filled by queue replay; stress misses everything
    await px.onTrade("tok", 540_000n, 600_000_000n, NOW + 1000, "conservative");
    expect(rec.status).toBe("PARTIAL");
    await px.cancel(rec.id, "test cancel", NOW + 2000);
    variants.onResolution("m1", "UP", NOW + 5000);
    await persistence.settle();
    const stress = (await db.db.select().from(paperVariantResults))
      .find((r) => r.decisionId === ids.decisionId && r.variant === "CONSERVATIVE_STRESS")!;
    expect(stress.fillSize6).toBe(0n);
    expect(stress.filled).toBe(false);
    // adverse penalty on the remaining notional (250 sh * 0.55 * 100bps), no shares granted
    expect(stress.pnl6).toBe(-1_375_000n);
  });
});

describe("seeded rng", () => {
  it("same seed same stream; different seeds diverge", () => {
    const a1 = new SeededRng("corr-A");
    const a2 = new SeededRng("corr-A");
    const b = new SeededRng("corr-B");
    const s1 = Array.from({ length: 16 }, () => a1.next());
    const s2 = Array.from({ length: 16 }, () => a2.next());
    const s3 = Array.from({ length: 16 }, () => b.next());
    expect(s1).toEqual(s2);
    expect(s1).not.toEqual(s3);
    for (const x of s1) expect(x >= 0 && x < 1).toBe(true);
  });
});

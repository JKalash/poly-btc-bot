import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { DEFAULT_CONFIG } from "@b5p/config";
import {
  decisionSnapshots, makeDb, marketExposureGuards, orderIntents, orders,
  type Db, type DbHandle,
} from "@b5p/db";
import type { LiveClobAdapter } from "@b5p/polymarket";
import { BookState } from "@b5p/strategy";
import { Accounting } from "../src/accounting";
import { DirectionalExposureConflictError, directionalMarketOwnerId } from "../src/directional-exposure-guard";
import { LiveController } from "../src/live";
import { MarketExposureGuardStore } from "../src/market-exposure-guard-store";
import { PaperExecutor, type FillEvent } from "../src/paper";

const NOW = 1_800_000_000_000;
let db: DbHandle;

beforeEach(async () => {
  db = await makeDb({ pgliteDir: "memory://", databaseUrl: undefined });
  await db.migrate();
});
afterEach(async () => db.close());

async function seedIntent(marketId: string, suffix: string): Promise<{ decisionId: string; intentId: string }> {
  const decisionId = `decision-${suffix}`;
  const intentId = `intent-${suffix}`;
  await db.db.insert(decisionSnapshots).values({ decisionId, marketId, mode: "paper", correlationId: `corr-${suffix}`, data: {}, createdAtMs: NOW });
  await db.db.insert(orderIntents).values({ id: intentId, decisionId, version: 1, idempotencyKey: `idem-${suffix}`, payload: {}, createdAtMs: NOW });
  return { decisionId, intentId };
}

function submitArgs(ids: { decisionId: string; intentId: string }, marketId = "market") {
  return {
    ...ids, marketId, tokenId: "token", outcomeSide: "UP" as const,
    style: "maker_post_only" as const, price6: 500_000n, shares6: 10_000_000n,
    stakeCap6: 10_000_000n, exitPolicy: "hold_to_resolution", nowMs: NOW,
    cfg: DEFAULT_CONFIG, cancelAtSecondsRemaining: 45, marketEndEpoch: Math.floor(NOW / 1000) + 300,
  };
}

function paper(accounting?: Accounting): PaperExecutor {
  const book = new BookState("token");
  book.applySnapshot([{ price: "0.50", size: "100" }], [{ price: "0.55", size: "100" }], NOW, NOW);
  return new PaperExecutor(
    db, () => 0n, () => "usdc", async () => undefined, () => book,
    accounting === undefined ? undefined : async (fill: FillEvent, executor: Db) => accounting.onFill({
      marketId: fill.order.marketId, decisionId: fill.order.decisionId, side: fill.order.outcomeSide,
      shares6: fill.shares6, price6: fill.price6, fee6: fill.fee6,
      stake6: fill.order.stakeCap6, exitPolicy: fill.order.exitPolicy, nowMs: fill.tsMs,
    }, executor),
  );
}

async function guard(marketId = "market") {
  return (await db.db.select().from(marketExposureGuards)).find((row) => row.marketId === marketId)!;
}

describe("paper directional ownership composition", () => {
  it("blocks pair-owned markets before a directional order is persisted", async () => {
    await new MarketExposureGuardStore(db).acquire({
      marketId: "market", ownerKind: "PAIR_GROUP", ownerId: "pair", ownerState: "SCHEDULED", acquiredAtMs: NOW,
    });
    const ids = await seedIntent("market", "blocked");
    await expect(paper().submit(submitArgs(ids))).rejects.toBeInstanceOf(DirectionalExposureConflictError);
    expect(await db.db.select().from(orders)).toHaveLength(0);
    expect(await guard()).toMatchObject({ ownerKind: "PAIR_GROUP", ownerId: "pair", releasedAtMs: null });
  });

  it("allows multiple same-market orders and releases only after every no-fill order is terminal", async () => {
    const px = paper();
    const first = await px.submit(submitArgs(await seedIntent("market", "one")));
    const second = await px.submit(submitArgs(await seedIntent("market", "two")));
    expect(await guard()).toMatchObject({ ownerKind: "DIRECTIONAL_ORDER", ownerId: directionalMarketOwnerId("market"), releasedAtMs: null });
    await px.cancel(first.id, "first canceled", NOW + 1);
    expect((await guard()).releasedAtMs).toBeNull();
    await px.cancel(second.id, "second canceled", NOW + 2);
    expect(await guard()).toMatchObject({ ownerState: "CANCELED", releasedAtMs: NOW + 2 });
  });

  it("hands ownership to the first filled position and releases only with resolution", async () => {
    const accounting = new Accounting(db, "paper");
    await accounting.reconcile(DEFAULT_CONFIG, NOW - 1);
    const px = paper(accounting);
    const rec = await px.submit({ ...submitArgs(await seedIntent("market", "fill")), style: "taker_fak", price6: 550_000n });
    await px.step(NOW + DEFAULT_CONFIG.paper.simulated_latency_ms);
    expect(rec.filled6).toBeGreaterThan(0n);
    expect(await guard()).toMatchObject({ ownerKind: "DIRECTIONAL_POSITION", ownerState: "OPEN", releasedAtMs: null });
    await accounting.onResolution("market", "UP", NOW + 1_000);
    expect(await guard()).toMatchObject({ ownerKind: "DIRECTIONAL_POSITION", ownerState: "FLAT", releasedAtMs: NOW + 1_000 });
  });

  it("restart cancels orphan no-fill orders but conservatively restores filled position ownership", async () => {
    const pendingPx = paper();
    await pendingPx.submit(submitArgs(await seedIntent("market", "orphan")));
    await paper().reconcileOrphans(NOW + 10);
    expect(await guard()).toMatchObject({ ownerState: "CANCELED", releasedAtMs: NOW + 10 });

    const accounting = new Accounting(db, "paper");
    await accounting.reconcile(DEFAULT_CONFIG, NOW + 20);
    const filledPx = paper(accounting);
    await filledPx.submit({ ...submitArgs(await seedIntent("market", "restart-fill")), style: "taker_fak", price6: 550_000n, nowMs: NOW + 20 });
    await filledPx.step(NOW + 20 + DEFAULT_CONFIG.paper.simulated_latency_ms);
    const restarted = new Accounting(db, "paper");
    await restarted.reconcile(DEFAULT_CONFIG, NOW + 100);
    expect(await guard()).toMatchObject({ ownerKind: "DIRECTIONAL_POSITION", ownerState: "OPEN", releasedAtMs: null });
  });

  it("does not let an older resolved position release a later unreconciled fill", async () => {
    const accounting = new Accounting(db, "paper");
    await accounting.reconcile(DEFAULT_CONFIG, NOW - 1);
    const px = paper(accounting);
    await px.submit({ ...submitArgs(await seedIntent("market", "old-cycle")), style: "taker_fak", price6: 550_000n });
    await px.step(NOW + DEFAULT_CONFIG.paper.simulated_latency_ms);
    await accounting.onResolution("market", "UP", NOW + 1_000);

    const later = await px.submit({
      ...submitArgs(await seedIntent("market", "new-cycle")),
      style: "taker_fak",
      price6: 550_000n,
      nowMs: NOW + 2_000,
    });
    await db.db.update(orders).set({
      status: "MATCHED",
      filledShares6: later.shares6,
      updatedAtMs: NOW + 2_100,
    }).where(eq(orders.id, later.id));
    await new Accounting(db, "paper").reconcile(DEFAULT_CONFIG, NOW + 3_000);
    expect(await guard()).toMatchObject({
      ownerState: "FILL_RECONCILIATION_REQUIRED",
      releasedAtMs: null,
    });
  });
});

type AdapterResult = { accepted: boolean; status: string; externalId?: string; reason?: string };
function adapter(result: () => Promise<AdapterResult>) {
  return {
    submit: vi.fn(result),
    fillsForOrders: vi.fn(async () => new Map()),
    cancelAll: vi.fn(async () => ({ ok: true })),
    address: vi.fn(() => "0x0000000000000000000000000000000000000001"),
  };
}

function arm(controller: LiveController): void {
  (controller as unknown as { state: string }).state = "ARMED";
  (controller as unknown as { expiresAtMs: number }).expiresAtMs = NOW + 100_000;
}

function liveArgs(ids: { decisionId: string; intentId: string }, overrides: Partial<{ expireAtMs: number }> = {}) {
  return {
    ...ids, marketId: "market", tokenId: "token", outcomeSide: "UP" as const,
    style: "maker_post_only" as const, price6: 500_000n, shares6: 10_000_000n,
    stake6: 5_000_000n, tickSize6: 10_000n, negRisk: false,
    idempotencyKey: `live-${ids.intentId}`, nowMs: NOW, ...overrides,
  };
}

describe("live directional ownership composition", () => {
  it("commits guard+PENDING before the external call and retains both on unknown acknowledgement", async () => {
    const fake = adapter(async () => { throw new Error("ack unknown"); });
    const live = new LiveController(db, fake as unknown as LiveClobAdapter);
    arm(live);
    const ids = await seedIntent("market", "unknown-live");
    await expect(live.submit(liveArgs(ids))).rejects.toThrow("ack unknown");
    expect(await guard()).toMatchObject({ ownerKind: "DIRECTIONAL_ORDER", ownerState: "ACTIVE", releasedAtMs: null });
    expect(await db.db.select().from(orders)).toEqual([expect.objectContaining({ status: "PENDING", marketId: "market" })]);
  });

  it("releases a persisted rejected/no-fill order and blocks pair ownership before transport", async () => {
    const rejectedAdapter = adapter(async () => ({ accepted: false, status: "REJECTED", reason: "venue reject" }));
    const live = new LiveController(db, rejectedAdapter as unknown as LiveClobAdapter);
    arm(live);
    const result = await live.submit(liveArgs(await seedIntent("market", "reject-live")));
    expect(result.ok).toBe(false);
    expect(await guard()).toMatchObject({ ownerState: "REJECTED", releasedAtMs: NOW });

    await new MarketExposureGuardStore(db).acquire({ marketId: "pair-market", ownerKind: "PAIR_GROUP", ownerId: "pair", ownerState: "SCHEDULED", acquiredAtMs: NOW });
    const ids = await seedIntent("pair-market", "pair-live");
    await expect(live.submit({ ...liveArgs(ids), marketId: "pair-market" })).rejects.toBeInstanceOf(DirectionalExposureConflictError);
    expect(rejectedAdapter.submit).toHaveBeenCalledTimes(1);
  });

  it("moves persisted live fills to position ownership, retains through expiry, then releases at resolution", async () => {
    const fake = adapter(async () => ({ accepted: true, status: "LIVE", externalId: "external" }));
    const live = new LiveController(db, fake as unknown as LiveClobAdapter);
    arm(live);
    await live.submit(liveArgs(await seedIntent("market", "fill-live"), { expireAtMs: NOW + 100 }));
    (fake.fillsForOrders as ReturnType<typeof vi.fn>).mockResolvedValue(new Map([["external", { filledShares6: 5_000_000n, avgPrice6: 500_000n }]]));
    await live.pollOpenOrders(NOW + 50);
    expect(await guard()).toMatchObject({ ownerKind: "DIRECTIONAL_POSITION", ownerState: "OPEN", releasedAtMs: null });
    (fake.fillsForOrders as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());
    await live.pollOpenOrders(NOW + 60_101);
    expect((await guard()).releasedAtMs).toBeNull();
    await live.settle("market", "UP", NOW + 70_000);
    expect(await guard()).toMatchObject({ ownerKind: "DIRECTIONAL_POSITION", ownerState: "FLAT", releasedAtMs: NOW + 70_000 });
  });
});

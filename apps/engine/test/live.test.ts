import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type DbHandle } from "@b5p/db";
import { getLocalBus, CHANNELS } from "../src/bus";
import { LiveController, ARM_ACK_PHRASE } from "../src/live";
import { Engine } from "../src/engine";

let db: DbHandle;

beforeEach(async () => {
  db = await makeDb({ pgliteDir: "memory://", databaseUrl: undefined });
  await db.migrate();
});
afterEach(async () => { await db.close(); });

describe("LiveController — disarmed and unconfigured by default", () => {
  it("is not configured when no hot-wallet key is present", () => {
    delete process.env.LIVE_TRADING_ENABLED;
    delete process.env.HOT_WALLET_PRIVATE_KEY;
    const lc = new LiveController(db);
    expect(lc.configured).toBe(false);
    expect(lc.state).toBe("DISARMED");
    expect(lc.isArmed(Date.now())).toBe(false);
  });

  it("refuses to arm when not configured, even with a correct acknowledgement", async () => {
    const lc = new LiveController(db);
    const r = await lc.arm({ acknowledgement: ARM_ACK_PHRASE, ttlMinutes: 30, minUsdc: 5_000_000n }, Date.now());
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toContain("not configured");
    expect(lc.state).toBe("DISARMED");
  });

  it("rejects a wrong acknowledgement phrase before touching any wallet", async () => {
    process.env.LIVE_TRADING_ENABLED = "1";
    process.env.HOT_WALLET_PRIVATE_KEY = "0x" + "1".repeat(64);
    const lc = new LiveController(db);
    expect(lc.configured).toBe(true);
    const r = await lc.arm({ acknowledgement: "yes do it", ttlMinutes: 30, minUsdc: 5_000_000n }, Date.now());
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toContain("acknowledgement");
    expect(lc.state).toBe("DISARMED");
    delete process.env.LIVE_TRADING_ENABLED;
    delete process.env.HOT_WALLET_PRIVATE_KEY;
  });

  it("expires an armed window and reports disarmed after TTL", () => {
    const lc = new LiveController(db);
    // force an armed state directly (bypass wallet) to test expiry logic
    (lc as unknown as { state: string; expiresAtMs: number }).state = "ARMED";
    (lc as unknown as { expiresAtMs: number }).expiresAtMs = 1000;
    expect(lc.isArmed(500)).toBe(true);
    expect(lc.isArmed(2000)).toBe(false); // past expiry -> auto-disarm
    expect(lc.state).toBe("DISARMED");
  });

  it("tracks consecutive live losses and open markets", () => {
    const lc = new LiveController(db);
    lc.markOpen("m1");
    expect(lc.hasOpenPosition("m1")).toBe(true);
    lc.markClosed("m1", false);
    expect(lc.hasOpenPosition("m1")).toBe(false);
    expect(lc.consecutiveLosses).toBe(1);
    lc.markOpen("m2"); lc.markClosed("m2", true);
    expect(lc.consecutiveLosses).toBe(0);
  });

  it("unknown outcome (no recorded fill) is never counted as a loss", () => {
    const lc = new LiveController(db);
    lc.markOpen("m1"); lc.markClosed("m1", false);
    expect(lc.consecutiveLosses).toBe(1);
    lc.markOpen("m2"); lc.markClosed("m2", null); // no fill recorded -> unknown
    expect(lc.hasOpenPosition("m2")).toBe(false);
    expect(lc.consecutiveLosses).toBe(1); // unchanged: not a win, not a loss
  });

  it("reconcile() restores the live loss streak from persisted live pnl_records (#61 live path)", async () => {
    const { pnlRecords } = await import("@b5p/db");
    const base = Date.now();
    await db.db.insert(pnlRecords).values([
      // oldest -> newest: win, then two losses (current streak = 2)
      { id: "p1", mode: "live", marketId: "m1", gross6: 10n, fees6: 0n, rebates6: 0n, net6: 10n, createdAtMs: base - 3000 },
      { id: "p2", mode: "live", marketId: "m2", gross6: -5n, fees6: 0n, rebates6: 0n, net6: -5n, createdAtMs: base - 2000 },
      { id: "p3", mode: "live", marketId: "m3", gross6: -5n, fees6: 0n, rebates6: 0n, net6: -5n, createdAtMs: base - 1000 },
      // paper records must not contaminate the live streak
      { id: "p4", mode: "paper", marketId: "m4", gross6: -5n, fees6: 0n, rebates6: 0n, net6: -5n, createdAtMs: base - 500 },
    ]);
    const lc = new LiveController(db);
    await lc.reconcile();
    expect(lc.consecutiveLosses).toBe(2); // restart cannot silently re-arm the stop
  });

  it("settle() with no recorded fill returns null and leaves the loss counter alone", async () => {
    const lc = new LiveController(db);
    lc.markOpen("m-nofill");
    const net = await lc.settle("m-nofill", "UP", Date.now());
    expect(net).toBeNull();
    expect(lc.hasOpenPosition("m-nofill")).toBe(false);
    expect(lc.consecutiveLosses).toBe(0);
    expect(lc.openExposure6()).toBe(0n);
  });
});

describe("Engine — live stays unavailable without config; paper path unaffected", () => {
  it("boots with live DISARMED and configured=false; kill switch disarms", async () => {
    delete process.env.LIVE_TRADING_ENABLED;
    delete process.env.HOT_WALLET_PRIVATE_KEY;
    const engine = new Engine(db, getLocalBus(), "paper");
    await engine.start(Date.now());
    expect(engine.live.configured).toBe(false);
    expect(engine.live.isArmed(Date.now())).toBe(false);
    const st = engine.cockpitState(Date.now()) as { live: { configured: boolean; state: string } };
    expect(st.live.configured).toBe(false);
    expect(st.live.state).toBe("DISARMED");

    // an arm control message cannot arm an unconfigured engine
    getLocalBus().publish(CHANNELS.control, { type: "arm", acknowledgement: ARM_ACK_PHRASE, ttlMinutes: 30, actor: "test" });
    await new Promise((r) => setTimeout(r, 50));
    expect(engine.live.isArmed(Date.now())).toBe(false);
    engine.stop();
  });
});

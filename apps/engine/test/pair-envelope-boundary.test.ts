import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type DbHandle } from "@b5p/db";
import { isObserverEligibleIntegrity, isPaperEligibleIntegrity } from "@b5p/strategy";
import { getLocalBus } from "../src/bus";
import { Engine, type PriceChangeEnvelopeInput } from "../src/engine";

/**
 * BPAIR-012 — complete envelope boundary at the engine (spec §12.2/§12.3,
 * test requirements §24.8 and the engine-applicable rows of §24.7).
 *
 * The pair observer/runtime does not exist yet (Phase 3), so "no pair
 * evaluation occurs between changes" is pinned here by its mechanical
 * precondition: one envelope produces exactly one bookVersion increment per
 * affected token and no torn intermediate version is ever observable. The
 * half-envelope fixture below is constructed exactly per §24.8 (first change
 * alone creates UP ask + DOWN ask < 1, second change removes it) and asserts
 * the post-boundary state carries no synthetic opportunity.
 */

const UP = "tok-up";
const DOWN = "tok-down";
const E1 = "epoch-1";
const E2 = "epoch-2";
const T0 = 1_785_500_000_000;

let db: DbHandle;
let engine: Engine;

beforeEach(async () => {
  db = await makeDb({ pgliteDir: "memory://", databaseUrl: undefined });
  await db.migrate();
  engine = new Engine(db, getLocalBus(), "paper");
});

afterEach(async () => {
  engine.stop();
  await db.close();
});

function snapshotBoth(epoch: string, ts: number): void {
  engine.onBookSnapshot(UP, [{ price: "0.49", size: "100" }], [{ price: "0.50", size: "100" }], ts, ts, {
    connectionEpoch: epoch, marketId: "m1", exchangeHash: "snap-up", sourceEventId: `snap-up-${epoch}`,
  });
  engine.onBookSnapshot(DOWN, [{ price: "0.49", size: "100" }], [{ price: "0.50", size: "100" }], ts, ts, {
    connectionEpoch: epoch, marketId: "m1", exchangeHash: "snap-down", sourceEventId: `snap-down-${epoch}`,
  });
}

describe("complete envelope boundary (§12.2, §24.8)", () => {
  it("applies a cross-token envelope as one unit: one version bump per book, no synthetic opportunity", () => {
    snapshotBoth(E1, T0);
    const upBook = engine.bookFor(UP);
    const downBook = engine.bookFor(DOWN);
    expect(upBook.integrity).toBe("VERIFIED_SNAPSHOT");
    const upV0 = upBook.bookVersion;
    const downV0 = downBook.bookVersion;
    const dirty: Array<{ marketId: string; envelopeId: string; askSum6: bigint }> = [];
    engine.setPairEnvelopeDirtyMarker((marketId, envelopeId) => {
      dirty.push({ marketId, envelopeId, askSum6: engine.bookFor(UP).bestAsk()! + engine.bookFor(DOWN).bestAsk()! });
    });

    // §24.8 fixture: change 1 alone makes UP ask + DOWN ask = 0.49+0.50 < 1;
    // change 2 (DOWN ask -> 0.51) removes it. One envelope, one unit.
    const outcomes = engine.onPriceChangeEnvelope({
      envelopeId: "envelope-1",
      marketId: "m1",
      sourceTsMs: T0 + 10,
      receivedTsMs: T0 + 11,
      changes: [
        { assetId: UP, price: "0.50", size: "0", side: "SELL", hash: "e1h" }, // remove 0.50 ask
        { assetId: UP, price: "0.49", size: "40", side: "SELL", hash: "e1h" }, // add 0.49 ask
        { assetId: DOWN, price: "0.50", size: "0", side: "SELL", hash: "e2h" }, // remove 0.50 ask
        { assetId: DOWN, price: "0.51", size: "40", side: "SELL", hash: "e2h" }, // add 0.51 ask
      ],
      meta: { connectionEpoch: E1, sourceEventId: "env-1" },
    });

    expect(outcomes.get(UP)).toBe("APPLIED");
    expect(outcomes.get(DOWN)).toBe("APPLIED");
    // exactly one book mutation per affected token (one version increment)
    expect(upBook.bookVersion).toBe(upV0 + 1n);
    expect(downBook.bookVersion).toBe(downV0 + 1n);
    // final capture contains BOTH changes; the transient opportunity is not observable
    expect(upBook.bestAsk()).toBe(490_000n);
    expect(downBook.bestAsk()).toBe(510_000n);
    expect(upBook.bestAsk()! + downBook.bestAsk()!).toBe(1_000_000n);
    // envelope metadata landed as provenance; continuity honestly demoted
    expect(upBook.integrity).toBe("UNSEQUENCED_AFTER_SNAPSHOT");
    expect(upBook.sourceEventId).toBe("env-1");
    expect(upBook.exchangeHash).toBe("e1h");
    expect(downBook.exchangeHash).toBe("e2h");
    expect(upBook.marketId).toBe("m1");
    expect(dirty).toEqual([{ marketId: "m1", envelopeId: "envelope-1", askSum6: 1_000_000n }]);
  });

  it("duplicate envelope delivery: same id+hash ignored and counted; id with different hash invalidates (§12.5)", () => {
    snapshotBoth(E1, T0);
    const upBook = engine.bookFor(UP);
    const env: PriceChangeEnvelopeInput = {
      envelopeId: "envelope-9",
      marketId: "m1",
      sourceTsMs: T0 + 10,
      receivedTsMs: T0 + 11,
      changes: [{ assetId: UP, price: "0.50", size: "80", side: "SELL", hash: "h-a" }],
      meta: { connectionEpoch: E1, sourceEventId: "env-9" },
    };
    expect(engine.onPriceChangeEnvelope(env).get(UP)).toBe("APPLIED");
    const v1 = upBook.bookVersion;

    // exact redelivery: ignored, counted, no version bump
    expect(engine.onPriceChangeEnvelope(env).get(UP)).toBe("DUPLICATE_IGNORED");
    expect(upBook.bookVersion).toBe(v1);
    expect(upBook.duplicateIgnoredCount).toBe(1);

    // same id, different payload: feed unhealthy, book invalidated
    expect(engine.onPriceChangeEnvelope({
      ...env,
      changes: [{ assetId: UP, price: "0.50", size: "75", side: "SELL", hash: "h-b" }],
    }).get(UP)).toBe("REJECTED_DUPLICATE_PAYLOAD_MISMATCH");
    expect(upBook.duplicatePayloadMismatchCount).toBe(1);
    expect(upBook.integrity).toBe("GAP_SUSPECTED");
    expect(upBook.asks.get(500_000n)).toBe(80_000_000n); // rejected: levels untouched
  });

  it("an envelope stamped with a foreign epoch invalidates without applying (§12.5)", () => {
    snapshotBoth(E1, T0);
    const upBook = engine.bookFor(UP);
    const outcome = engine.onPriceChangeEnvelope({
      envelopeId: "foreign-epoch",
      marketId: "m1",
      sourceTsMs: T0 + 10,
      receivedTsMs: T0 + 11,
      changes: [{ assetId: UP, price: "0.50", size: "0", side: "SELL" }],
      meta: { connectionEpoch: E2 }, // book is on E1: a reset was missed
    });
    expect(outcome.get(UP)).toBe("REJECTED_EPOCH_MISMATCH");
    expect(upBook.integrity).toBe("INVALID_AFTER_RECONNECT");
    expect(upBook.asks.get(500_000n)).toBe(100_000_000n); // untouched
  });

  it("an empty envelope touches nothing", () => {
    snapshotBoth(E1, T0);
    const v = engine.bookFor(UP).bookVersion;
    const outcomes = engine.onPriceChangeEnvelope({ envelopeId: "empty", marketId: "m1", sourceTsMs: T0 + 1, receivedTsMs: T0 + 1, changes: [] });
    expect(outcomes.size).toBe(0);
    expect(engine.bookFor(UP).bookVersion).toBe(v);
  });
});

describe("reconnect barrier wiring (§12.3, §24.7)", () => {
  it("epoch change invalidates all books; deltas never revive; only fresh same-epoch snapshots restore", () => {
    snapshotBoth(E1, T0);
    engine.onPriceChangeEnvelope({
      envelopeId: "before-reconnect",
      marketId: "m1", sourceTsMs: T0 + 5, receivedTsMs: T0 + 5,
      changes: [{ assetId: UP, price: "0.50", size: "90", side: "SELL" }],
      meta: { connectionEpoch: E1 },
    });
    const upBook = engine.bookFor(UP);
    const downBook = engine.bookFor(DOWN);
    expect(isObserverEligibleIntegrity(upBook.integrity)).toBe(true);

    // reconnect: both invalid immediately, old levels retained but never eligible
    engine.onConnectionEpochChange(E2, E1);
    expect(upBook.integrity).toBe("INVALID_AFTER_RECONNECT");
    expect(downBook.integrity).toBe("INVALID_AFTER_RECONNECT");
    expect(upBook.connectionEpoch).toBe(E2);
    expect(upBook.bestAsk()).not.toBeNull(); // retained for diagnostics only
    expect(isObserverEligibleIntegrity(upBook.integrity)).toBe(false);

    // a delta before the new snapshot must not revive the book
    const outcome = engine.onPriceChangeEnvelope({
      envelopeId: "after-reconnect",
      marketId: "m1", sourceTsMs: T0 + 20, receivedTsMs: T0 + 20,
      changes: [
        { assetId: UP, price: "0.50", size: "85", side: "SELL" },
        { assetId: DOWN, price: "0.50", size: "85", side: "SELL" },
      ],
      meta: { connectionEpoch: E2 },
    });
    expect(outcome.get(UP)).toBe("APPLIED_WHILE_INVALID");
    expect(upBook.integrity).toBe("INVALID_AFTER_RECONNECT");
    expect(downBook.integrity).toBe("INVALID_AFTER_RECONNECT");

    // new UP snapshot only: pair still invalid (DOWN stale)
    engine.onBookSnapshot(UP, [{ price: "0.49", size: "100" }], [{ price: "0.50", size: "100" }], T0 + 30, T0 + 30, {
      connectionEpoch: E2, marketId: "m1",
    });
    expect(upBook.integrity).toBe("VERIFIED_SNAPSHOT");
    expect(downBook.integrity).toBe("INVALID_AFTER_RECONNECT");

    // DOWN snapshot from the OLD epoch does not restore validity
    engine.onBookSnapshot(DOWN, [{ price: "0.49", size: "100" }], [{ price: "0.50", size: "100" }], T0 + 31, T0 + 31, {
      connectionEpoch: E1, marketId: "m1",
    });
    expect(downBook.integrity).toBe("INVALID_AFTER_RECONNECT");

    // fresh DOWN snapshot in the current epoch: eligibility restored
    engine.onBookSnapshot(DOWN, [{ price: "0.49", size: "100" }], [{ price: "0.50", size: "100" }], T0 + 32, T0 + 32, {
      connectionEpoch: E2, marketId: "m1",
    });
    expect(downBook.integrity).toBe("VERIFIED_SNAPSHOT");
    expect(isPaperEligibleIntegrity(upBook.integrity)).toBe(true);
    expect(isPaperEligibleIntegrity(downBook.integrity)).toBe(true);
  });

  it("applies the current epoch barrier to a token first seen after reconnect", () => {
    engine.onConnectionEpochChange(E2, E1);

    const outcome = engine.onPriceChangeEnvelope({
      envelopeId: "late-token",
      marketId: "m1",
      sourceTsMs: T0 + 20,
      receivedTsMs: T0 + 20,
      changes: [{ assetId: "tok-late", price: "0.50", size: "85", side: "SELL" }],
      meta: { connectionEpoch: E2 },
    });
    const lateBook = engine.bookFor("tok-late");
    expect(outcome.get("tok-late")).toBe("APPLIED_WHILE_INVALID");
    expect(lateBook.marketId).toBe("m1");
    expect(lateBook.connectionEpoch).toBe(E2);
    expect(lateBook.integrity).toBe("INVALID_AFTER_RECONNECT");

    // The late-created book must not treat a delayed snapshot from the prior
    // connection as its first epoch and accidentally become eligible.
    engine.onBookSnapshot("tok-late", [], [{ price: "0.50", size: "100" }], T0 + 21, T0 + 21, {
      connectionEpoch: E1,
      marketId: "m1",
    });
    expect(lateBook.integrity).toBe("INVALID_AFTER_RECONNECT");

    engine.onBookSnapshot("tok-late", [], [{ price: "0.50", size: "100" }], T0 + 22, T0 + 22, {
      connectionEpoch: E2,
      marketId: "m1",
    });
    expect(lateBook.integrity).toBe("VERIFIED_SNAPSHOT");
  });
});

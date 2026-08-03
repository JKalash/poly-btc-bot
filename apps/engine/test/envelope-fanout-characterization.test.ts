/**
 * BPAIR-002 characterization tests for the ws price_change envelope boundary.
 *
 * Today apps/engine/src/main.ts fans a whole price_change envelope out
 * per-level in an inline closure:
 *
 *   onPriceChange: (msg, ts) => {
 *     for (const c of msg.price_changes) {
 *       engine.onPriceChange(c.asset_id, c.price, c.size, c.side, tsToMs(msg.timestamp, ts), ts);
 *     }
 *   }
 *
 * That closure itself is not importable, so these tests pin the two halves of
 * the seam it sits on, replicating the loop verbatim where needed:
 *  1. ClobMarketWs parses/dispatches an envelope as ONE onPriceChange callback
 *     carrying ALL levels (injected via its private `handle`, no socket).
 *  2. Engine.onPriceChange applies ONE level immediately and independently —
 *     there is NO envelope atomicity at the engine boundary. Mid-envelope
 *     states (including transiently crossed books) are observable, and a
 *     malformed level aborts the fan-out loop HALF-APPLIED.
 *
 * BPAIR-012 will replace this with a whole-envelope engine method; these
 * tests document exactly what changes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type DbHandle } from "@b5p/db";
import { ClobMarketWs, tsToMs, type PriceChangeMsg } from "@b5p/polymarket";
import type { z } from "zod";
import { getLocalBus } from "../src/bus";
import { Engine } from "../src/engine";

let db: DbHandle;
let engine: Engine;

// fixed test timeline (repo idiom)
const START = 1_785_500_100_000;
const RECV = START + 45;

type Envelope = z.infer<typeof PriceChangeMsg>;

/** Inject a raw ws text frame into ClobMarketWs without opening a socket. */
function inject(clob: ClobMarketWs, payload: unknown, receivedTsMs: number): void {
  (clob as unknown as { handle(data: string, ts: number): void }).handle(JSON.stringify(payload), receivedTsMs);
}

beforeEach(async () => {
  db = await makeDb({ pgliteDir: "memory://", databaseUrl: undefined });
  await db.migrate();
  engine = new Engine(db, getLocalBus(), "paper");
  await engine.start(START - 1000);
});

afterEach(async () => {
  engine.stop();
  await db.close();
});

function seedBooks(): void {
  engine.onBookSnapshot("tok-up",
    [{ price: "0.55", size: "500" }],
    [{ price: "0.56", size: "400" }, { price: "0.60", size: "700" }],
    START - 200, START - 200);
  engine.onBookSnapshot("tok-down",
    [{ price: "0.44", size: "450" }],
    [{ price: "0.45", size: "350" }],
    START - 200, START - 200);
}

describe("ClobMarketWs dispatch: an envelope arrives as ONE callback with all levels", () => {
  it("delivers the whole price_change envelope to a single onPriceChange call", () => {
    const calls: Array<{ msg: Envelope; ts: number }> = [];
    const clob = new ClobMarketWs({
      onBook: () => { throw new Error("unexpected onBook"); },
      onPriceChange: (msg, ts) => calls.push({ msg, ts }),
      onLastTrade: () => { throw new Error("unexpected onLastTrade"); },
    });
    inject(clob, {
      event_type: "price_change",
      market: "0xcond",
      timestamp: "1785500100", // seconds — tsToMs must scale it
      price_changes: [
        { asset_id: "tok-up", price: "0.57", size: "100", side: "BUY" },
        { asset_id: "tok-up", price: "0.56", size: "0", side: "SELL" },
        { asset_id: "tok-down", price: "0.43", size: "50", side: "BUY" },
      ],
    }, RECV);
    expect(calls.length).toBe(1); // ONE envelope -> ONE callback
    expect(calls[0]!.msg.price_changes.length).toBe(3); // all levels intact
    expect(calls[0]!.ts).toBe(RECV);
    // an envelope recognized by shape alone (no event_type) also dispatches
    inject(clob, { market: "0xcond", price_changes: [{ asset_id: "tok-up", price: "0.5", size: "1", side: "BUY" }] }, RECV + 1);
    expect(calls.length).toBe(2);
  });

  it("an initial ARRAY of book snapshots fans out to one onBook per element", () => {
    const books: string[] = [];
    const clob = new ClobMarketWs({
      onBook: (msg) => books.push(msg.asset_id),
      onPriceChange: () => { throw new Error("unexpected onPriceChange"); },
      onLastTrade: () => { throw new Error("unexpected"); },
    });
    inject(clob, [
      { market: "0xcond", asset_id: "tok-up", bids: [], asks: [] },
      { market: "0xcond", asset_id: "tok-down", bids: [], asks: [] },
    ], RECV);
    expect(books).toEqual(["tok-up", "tok-down"]);
  });

  it("tsToMs heuristic: seconds are scaled, milliseconds pass through, junk falls back", () => {
    expect(tsToMs("1785500100", RECV)).toBe(1_785_500_100_000);
    expect(tsToMs(1_785_500_100_123, RECV)).toBe(1_785_500_100_123);
    expect(tsToMs(undefined, RECV)).toBe(RECV);
    expect(tsToMs("not-a-number", RECV)).toBe(RECV);
  });
});

describe("Engine.onPriceChange: per-level fan-out has NO envelope atomicity", () => {
  it("each level applies immediately; mid-envelope the book is transiently crossed", () => {
    seedBooks();
    // an envelope that moves the top of book up: new bid 0.57 arrives before
    // the 0.56 ask cancellation that accompanies it
    const envelope: Envelope = {
      market: "0xcond",
      timestamp: "1785500100",
      price_changes: [
        { asset_id: "tok-up", price: "0.57", size: "100", side: "BUY" },
        { asset_id: "tok-up", price: "0.56", size: "0", side: "SELL" },
      ],
    };
    const sourceTs = tsToMs(envelope.timestamp, RECV);

    // fan out level 1 only (main.ts loop, first iteration)
    const [first, second] = envelope.price_changes;
    engine.onPriceChange(first!.asset_id, first!.price, first!.size, first!.side, sourceTs, RECV);
    const up = engine.books.get("tok-up")!;
    expect(up.bestBid()).toBe(570_000n); // half-applied envelope is observable
    expect(up.bestAsk()).toBe(560_000n);
    expect(up.spread()).toBe(-10_000n); // transiently CROSSED

    // second iteration completes the envelope and uncrosses
    engine.onPriceChange(second!.asset_id, second!.price, second!.size, second!.side, sourceTs, RECV);
    expect(up.bestBid()).toBe(570_000n);
    expect(up.bestAsk()).toBe(600_000n);
    expect(up.spread()).toBe(30_000n);
    expect(up.sourceTsMs).toBe(1_785_500_100_000); // envelope ts stamped per level
    expect(up.receivedTsMs).toBe(RECV);
  });

  it("levels for different tokens route to per-token books; unknown tokens auto-create a book", () => {
    seedBooks();
    expect(engine.books.has("tok-mystery")).toBe(false);
    engine.onPriceChange("tok-mystery", "0.10", "25", "SELL", START, RECV);
    expect(engine.books.has("tok-mystery")).toBe(true); // bookFor() created it
    expect(engine.books.get("tok-mystery")!.bestAsk()).toBe(100_000n);
    // and the seeded books were untouched
    expect(engine.books.get("tok-up")!.bestBid()).toBe(550_000n);
    expect(engine.books.get("tok-down")!.bestAsk()).toBe(450_000n);
  });

  it("QUIRK: a malformed level throws synchronously, leaving the envelope HALF-APPLIED", () => {
    seedBooks();
    const envelope: Envelope = {
      market: "0xcond",
      timestamp: "1785500100",
      price_changes: [
        { asset_id: "tok-up", price: "0.57", size: "100", side: "BUY" }, // applies
        { asset_id: "tok-up", price: "1.01", size: "100", side: "SELL" }, // throws (prob > 1)
        { asset_id: "tok-up", price: "0.58", size: "100", side: "BUY" }, // never reached
      ],
    };
    const sourceTs = tsToMs(envelope.timestamp, RECV);
    // replicate main.ts's fan-out loop verbatim
    expect(() => {
      for (const c of envelope.price_changes) {
        engine.onPriceChange(c.asset_id, c.price, c.size, c.side, sourceTs, RECV);
      }
    }).toThrow("prob out of [0,1]");
    const up = engine.books.get("tok-up")!;
    expect(up.bestBid()).toBe(570_000n); // level 1 stuck
    expect(up.bids.has(580_000n)).toBe(false); // level 3 never applied
    expect(up.sourceTsMs).toBe(1_785_500_100_000); // ts already advanced by level 1
  });

  it("end-to-end: raw ws frame through ClobMarketWs wired exactly like main.ts", () => {
    seedBooks();
    const clob = new ClobMarketWs({
      onBook: (msg, ts) => {
        engine.onBookSnapshot(msg.asset_id, msg.bids, msg.asks, tsToMs(msg.timestamp, ts), ts);
      },
      onPriceChange: (msg, ts) => {
        for (const c of msg.price_changes) {
          engine.onPriceChange(c.asset_id, c.price, c.size, c.side, tsToMs(msg.timestamp, ts), ts);
        }
      },
      onLastTrade: () => { /* not exercised here */ },
    });
    inject(clob, {
      event_type: "price_change",
      market: "0xcond",
      timestamp: "1785500100",
      price_changes: [
        { asset_id: "tok-up", price: "0.55", size: "0", side: "BUY" },
        { asset_id: "tok-up", price: "0.54", size: "900", side: "BUY" },
        { asset_id: "tok-down", price: "0.45", size: "0", side: "SELL" },
        { asset_id: "tok-down", price: "0.46", size: "120", side: "SELL" },
      ],
    }, RECV);
    const up = engine.books.get("tok-up")!;
    const down = engine.books.get("tok-down")!;
    expect(up.bestBid()).toBe(540_000n);
    expect(down.bestAsk()).toBe(460_000n);
    expect(up.sourceTsMs).toBe(1_785_500_100_000);
    expect(down.sourceTsMs).toBe(1_785_500_100_000);
    expect(up.receivedTsMs).toBe(RECV);
  });
});

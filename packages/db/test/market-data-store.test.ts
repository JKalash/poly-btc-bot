import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MarketDataStore,
  canonicalMarketDataJson,
  makeDb,
  marketDataPayloadHash,
  schema,
  type DbHandle,
  type MarketDataEventInput,
} from "../src/index";

let handle: DbHandle;

beforeAll(async () => {
  handle = await makeDb({ pgliteDir: "memory://" });
  await handle.migrate();
}, 120_000);

afterAll(async () => { await handle.close(); });

function event(input: Partial<MarketDataEventInput> & Pick<MarketDataEventInput, "marketId" | "eventKind" | "connectionEpoch" | "envelopeId" | "sequenceInEnvelope">): MarketDataEventInput {
  const receivedTsMs = input.receivedTsMs ?? 1_800_000_000_000;
  const sourceTsMs = input.sourceTsMs === undefined ? receivedTsMs - 1 : input.sourceTsMs;
  return {
    tokenId: input.eventKind === "CONNECTION_RESET" || input.eventKind === "ENVELOPE_BOUNDARY" ? null : "up",
    sourceEventId: null,
    sourceTsMs,
    sourceTimestampKind: sourceTsMs === null ? "RECEIVE_FALLBACK" : "SOURCE",
    receivedTsMs,
    exchangeHash: null,
    payload: {},
    createdAtMs: receivedTsMs + 1,
    ...input,
  };
}

function boundary(input: Pick<MarketDataEventInput, "marketId" | "connectionEpoch" | "envelopeId" | "sequenceInEnvelope" | "receivedTsMs">): MarketDataEventInput {
  return event({
    ...input,
    eventKind: "ENVELOPE_BOUNDARY",
    tokenId: null,
    sourceTsMs: null,
    sourceTimestampKind: "RECEIVE_FALLBACK",
    payload: {},
  });
}

describe("market-data canonical serialization", () => {
  it("sorts object keys, stringifies bigint exactly, and rejects unsafe numbers", () => {
    expect(canonicalMarketDataJson({ z: 2n, a: { y: "3", x: 1 } })).toBe('{"a":{"x":1,"y":"3"},"z":"2"}');
    expect(marketDataPayloadHash({ z: 2n, a: 1 })).toBe(marketDataPayloadHash({ a: 1, z: "2" }));
    expect(() => canonicalMarketDataJson({ unsafe: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/safe integer/);
  });
});

describe("MarketDataStore append-only persistence and replay", () => {
  it("resolves a partially conflicting multi-envelope batch without duplicating trades", async () => {
    const store = new MarketDataStore(handle.db);
    const envelopeA = [
      event({
        marketId: "m-batch", tokenId: "up", eventKind: "TRADE", connectionEpoch: "epoch-b",
        envelopeId: "batch-a", sequenceInEnvelope: 0, receivedTsMs: 1_800_000_100_000,
        sourceTsMs: 1_800_000_099_900,
        payload: { price6: "510000", side: "BUY", size6: "2000000" },
      }),
      boundary({ marketId: "m-batch", connectionEpoch: "epoch-b", envelopeId: "batch-a", sequenceInEnvelope: 1, receivedTsMs: 1_800_000_100_001 }),
    ] as const;
    await store.appendEnvelope(envelopeA);

    const ticksAfterFirst = await handle.db.select().from(schema.marketTradeTicks)
      .where(eq(schema.marketTradeTicks.marketId, "m-batch"));
    expect(ticksAfterFirst).toHaveLength(1);

    // A flush batch packs several envelope groups. Replaying one that already
    // committed alongside a genuinely new one must insert only the new rows,
    // return every row in input order, and project the trade exactly once.
    const envelopeB = [
      event({
        marketId: "m-batch", tokenId: "up", eventKind: "DELTA", connectionEpoch: "epoch-b",
        envelopeId: "batch-b", sequenceInEnvelope: 0, receivedTsMs: 1_800_000_100_010,
        sourceTsMs: 1_800_000_099_950,
        payload: { bookVersion: "9", changes: [{ price6: "520000", side: "SELL", size6: "3000000" }] },
      }),
      boundary({ marketId: "m-batch", connectionEpoch: "epoch-b", envelopeId: "batch-b", sequenceInEnvelope: 1, receivedTsMs: 1_800_000_100_011 }),
    ] as const;

    const mixed = await store.appendBatch([...envelopeA, ...envelopeB]);
    expect(mixed).toHaveLength(4);
    expect(mixed.map((r) => [r.envelopeId, r.sequenceInEnvelope]))
      .toEqual([["batch-a", 0], ["batch-a", 1], ["batch-b", 0], ["batch-b", 1]]);
    // The replayed rows keep their original ids rather than being re-inserted.
    expect(mixed[0]!.id).toBe((await store.appendEnvelope(envelopeA))[0]!.id);

    const ticksAfterMixed = await handle.db.select().from(schema.marketTradeTicks)
      .where(eq(schema.marketTradeTicks.marketId, "m-batch"));
    expect(ticksAfterMixed).toHaveLength(1);
  });

  it("appends a batch larger than one insert chunk in input order", async () => {
    const store = new MarketDataStore(handle.db);
    const rows: MarketDataEventInput[] = [];
    // 600 rows crosses the 256-row chunk boundary the bulk writer uses.
    for (let i = 0; i < 300; i++) {
      rows.push(event({
        marketId: "m-chunk", tokenId: "up", eventKind: "DELTA", connectionEpoch: "epoch-c",
        envelopeId: `chunk-${i}`, sequenceInEnvelope: 0, receivedTsMs: 1_800_000_200_000 + i * 2,
        sourceTsMs: 1_800_000_199_000,
        payload: { bookVersion: String(i), changes: [{ price6: "500000", side: "BUY", size6: "1000000" }] },
      }));
      rows.push(boundary({
        marketId: "m-chunk", connectionEpoch: "epoch-c", envelopeId: `chunk-${i}`,
        sequenceInEnvelope: 1, receivedTsMs: 1_800_000_200_000 + i * 2 + 1,
      }));
    }
    const persisted = await store.appendBatch(rows);
    expect(persisted).toHaveLength(600);
    expect(persisted.map((r) => r.envelopeId)).toEqual(rows.map((r) => r.envelopeId));
    // Ids are monotonic, so input order survived the chunked inserts.
    for (let i = 1; i < persisted.length; i++) {
      expect(persisted[i]!.id > persisted[i - 1]!.id).toBe(true);
    }
  });

  it("atomically appends complete envelopes, projects trades once, and rejects conflicting retries", async () => {
    const store = new MarketDataStore(handle.db);
    const first = [
      event({
        marketId: "m-append", tokenId: "up", eventKind: "SNAPSHOT", connectionEpoch: "epoch-1",
        envelopeId: "env-1", sequenceInEnvelope: 0, receivedTsMs: 1_800_000_001_000,
        payload: { asks: [["510000", "2000000"]], bids: [["490000", "1000000"]], bookVersion: "7" },
      }),
      boundary({ marketId: "m-append", connectionEpoch: "epoch-1", envelopeId: "env-1", sequenceInEnvelope: 1, receivedTsMs: 1_800_000_001_001 }),
    ] as const;
    const firstRows = await store.appendEnvelope(first);
    expect(firstRows).toHaveLength(2);
    expect(firstRows[0]!.payload).toEqual({ asks: [["510000", "2000000"]], bids: [["490000", "1000000"]], bookVersion: "7" });

    const second = [
      event({
        marketId: "m-append", tokenId: "up", eventKind: "DELTA", connectionEpoch: "epoch-1",
        envelopeId: "env-2", sequenceInEnvelope: 0, receivedTsMs: 1_800_000_001_010,
        sourceTsMs: 1_800_000_000_900,
        payload: { changes: [
          { side: "BUY", price6: "490000", size6: "0" },
          { side: "BUY", price6: "480000", size6: "3000000" },
          { side: "SELL", price6: "505000", size6: "4000000" },
        ] },
      }),
      event({
        marketId: "m-append", tokenId: "up", eventKind: "TRADE", connectionEpoch: "epoch-1",
        envelopeId: "env-2", sequenceInEnvelope: 1, receivedTsMs: 1_800_000_001_011,
        payload: { price6: "505000", size6: "750000", side: "BUY" },
      }),
      boundary({ marketId: "m-append", connectionEpoch: "epoch-1", envelopeId: "env-2", sequenceInEnvelope: 2, receivedTsMs: 1_800_000_001_012 }),
    ] as const;
    const secondRows = await store.appendEnvelope(second);
    const retriedRows = await store.appendEnvelope(second);
    expect(retriedRows.map((row) => row.id)).toEqual(secondRows.map((row) => row.id));

    const persisted = await handle.db.select().from(schema.orderbookEvents).where(eq(schema.orderbookEvents.marketId, "m-append"));
    expect(persisted).toHaveLength(5);
    const trades = await handle.db.select().from(schema.marketTradeTicks).where(eq(schema.marketTradeTicks.marketId, "m-append"));
    expect(trades).toEqual([expect.objectContaining({ tokenId: "up", price6: 505000n, size6: 750000n, side: "BUY" })]);

    const replayed = await store.reconstructBook({ marketId: "m-append", tokenId: "up", useCheckpoint: false });
    expect(replayed.book).toEqual(expect.objectContaining({
      marketId: "m-append", tokenId: "up", connectionEpoch: "epoch-1", bookVersion: 8n,
      integrity: "UNSEQUENCED_AFTER_SNAPSHOT", sourceTsMs: 1_800_000_000_900,
      bids: [{ price6: "480000", size6: "3000000" }],
      asks: [{ price6: "505000", size6: "4000000" }, { price6: "510000", size6: "2000000" }],
      lastEventId: secondRows[2]!.id,
    }));

    await expect(store.appendEvent({ ...second[0], payload: { changes: [{ side: "BUY", price6: "480000", size6: "999" }] } }))
      .rejects.toThrow(/different evidence/);

    const rolledBack = event({
      marketId: "m-append", tokenId: "up", eventKind: "TRADE", connectionEpoch: "epoch-1",
      envelopeId: "env-rollback", sequenceInEnvelope: 0, receivedTsMs: 1_800_000_001_020,
      payload: { price6: "500000", size6: "1", side: null },
    });
    await expect(store.appendBatch([rolledBack, { ...second[0], receivedTsMs: 1_800_000_001_021 }])).rejects.toThrow(/different evidence/);
    expect(await handle.db.select().from(schema.orderbookEvents).where(eq(schema.orderbookEvents.envelopeId, "env-rollback"))).toHaveLength(0);
    expect(await handle.db.select().from(schema.marketTradeTicks).where(eq(schema.marketTradeTicks.marketId, "m-append"))).toHaveLength(1);
  });

  it("reconstructs checkpoint plus later events byte-for-byte with full replay", async () => {
    const store = new MarketDataStore(handle.db);
    const initial = await store.appendEnvelope([
      event({
        marketId: "m-checkpoint", tokenId: "down", eventKind: "SNAPSHOT", connectionEpoch: "epoch-cp",
        envelopeId: "cp-env-1", sequenceInEnvelope: 0, receivedTsMs: 1_800_000_002_000,
        payload: { bids: [["470000", "1000000"], ["460000", "2000000"]], asks: [["520000", "3000000"]] },
      }),
      boundary({ marketId: "m-checkpoint", connectionEpoch: "epoch-cp", envelopeId: "cp-env-1", sequenceInEnvelope: 1, receivedTsMs: 1_800_000_002_001 }),
    ]);
    const checkpoint = await store.createCheckpoint({ marketId: "m-checkpoint", tokenId: "down", throughEventId: initial[1]!.id });
    expect(checkpoint.book.lastEventId).toBe(initial[1]!.id);
    // A newer legacy snapshot has no checkpoint provenance and must not hide
    // the latest usable checkpoint (PostgreSQL sorts NULL first under DESC).
    await handle.db.insert(schema.orderbookSnapshots).values({
      marketId: "m-checkpoint", tokenId: "down", bids: [], asks: [],
      sourceTsMs: 1_800_000_002_005, receivedTsMs: 1_800_000_002_005,
    });

    const later = await store.appendEnvelope([
      event({
        marketId: "m-checkpoint", tokenId: "down", eventKind: "DELTA", connectionEpoch: "epoch-cp",
        envelopeId: "cp-env-2", sequenceInEnvelope: 0, receivedTsMs: 1_800_000_002_010,
        payload: { changes: [
          { side: "BUY", price6: "470000", size6: "0" },
          { side: "SELL", price6: "510000", size6: "2500000" },
        ] },
      }),
      boundary({ marketId: "m-checkpoint", connectionEpoch: "epoch-cp", envelopeId: "cp-env-2", sequenceInEnvelope: 1, receivedTsMs: 1_800_000_002_011 }),
    ]);

    const fromCheckpoint = await store.reconstructBook({ marketId: "m-checkpoint", tokenId: "down" });
    const fromOrigin = await store.reconstructBook({ marketId: "m-checkpoint", tokenId: "down", useCheckpoint: false });
    expect(fromCheckpoint.checkpointId).toBe(checkpoint.id);
    expect(fromCheckpoint.appliedEventIds).toEqual(later.map((row) => row.id));
    expect(fromCheckpoint.book).toEqual(fromOrigin.book);
    expect(marketDataPayloadHash(fromCheckpoint.book)).toBe(marketDataPayloadHash(fromOrigin.book));
  });

  it("retains reconnect barriers before the first snapshot and never revives on stale-epoch evidence", async () => {
    const store = new MarketDataStore(handle.db);
    await store.appendEnvelope([
      event({
        marketId: "m-reset", eventKind: "CONNECTION_RESET", connectionEpoch: "epoch-new",
        envelopeId: "reset-env", sequenceInEnvelope: 0, receivedTsMs: 1_800_000_003_000,
        sourceTsMs: null, sourceTimestampKind: "RECEIVE_FALLBACK", payload: { reason: "reconnect" },
      }),
      boundary({ marketId: "m-reset", connectionEpoch: "epoch-new", envelopeId: "reset-env", sequenceInEnvelope: 1, receivedTsMs: 1_800_000_003_001 }),
    ]);
    const stale = await store.appendEnvelope([
      event({
        marketId: "m-reset", tokenId: "up", eventKind: "SNAPSHOT", connectionEpoch: "epoch-old",
        envelopeId: "stale-env", sequenceInEnvelope: 0, receivedTsMs: 1_800_000_003_010,
        payload: { bids: [["400000", "1"]], asks: [["600000", "1"]] },
      }),
      boundary({ marketId: "m-reset", connectionEpoch: "epoch-old", envelopeId: "stale-env", sequenceInEnvelope: 1, receivedTsMs: 1_800_000_003_011 }),
    ]);
    const invalid = await store.reconstructBook({ marketId: "m-reset", tokenId: "up", useCheckpoint: false });
    expect(invalid.book).toMatchObject({ connectionEpoch: "epoch-new", integrity: "INVALID_AFTER_RECONNECT" });
    await expect(store.createCheckpoint({ marketId: "m-reset", tokenId: "up", throughEventId: stale[1]!.id })).rejects.toThrow(/invalid post-reset/);

    const recovered = await store.appendEnvelope([
      event({
        marketId: "m-reset", tokenId: "up", eventKind: "SNAPSHOT", connectionEpoch: "epoch-new",
        envelopeId: "recovery-env", sequenceInEnvelope: 0, receivedTsMs: 1_800_000_003_020,
        payload: { bids: [["450000", "2"]], asks: [["550000", "3"]] },
      }),
      boundary({ marketId: "m-reset", connectionEpoch: "epoch-new", envelopeId: "recovery-env", sequenceInEnvelope: 1, receivedTsMs: 1_800_000_003_021 }),
    ]);
    const valid = await store.reconstructBook({ marketId: "m-reset", tokenId: "up", useCheckpoint: false });
    expect(valid.book).toMatchObject({
      connectionEpoch: "epoch-new", integrity: "VERIFIED_SNAPSHOT", bookVersion: 2n,
      bids: [{ price6: "450000", size6: "2" }], asks: [{ price6: "550000", size6: "3" }],
      lastEventId: recovered[1]!.id,
    });
  });

  it("preserves missing source time honestly and refuses an unrepresentable checkpoint", async () => {
    const store = new MarketDataStore(handle.db);
    const rows = await store.appendEnvelope([
      event({
        marketId: "m-no-source", tokenId: "up", eventKind: "SNAPSHOT", connectionEpoch: "epoch-null",
        envelopeId: "null-env", sequenceInEnvelope: 0, receivedTsMs: 1_800_000_004_000,
        sourceTsMs: null, sourceTimestampKind: "RECEIVE_FALLBACK",
        payload: { bids: [], asks: [["500000", "1"]] },
      }),
      boundary({ marketId: "m-no-source", connectionEpoch: "epoch-null", envelopeId: "null-env", sequenceInEnvelope: 1, receivedTsMs: 1_800_000_004_001 }),
    ]);
    const replayed = await store.reconstructBook({ marketId: "m-no-source", tokenId: "up", useCheckpoint: false });
    expect(replayed.book?.sourceTsMs).toBeNull();
    expect(replayed.book?.sourceTimestampKind).toBe("RECEIVE_FALLBACK");
    await expect(store.createCheckpoint({ marketId: "m-no-source", tokenId: "up", throughEventId: rows[1]!.id }))
      .rejects.toThrow(/without a venue source timestamp/);
  });
});

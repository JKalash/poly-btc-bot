import { describe, expect, it, vi } from "vitest";
import { PairCaptureQueue, type PairMarketDataRecord } from "../src/pair-capture-queue";

function record(id: number, kind: PairMarketDataRecord["kind"] = "DELTA", tokenId: string | null = "up", epoch = "e1"): PairMarketDataRecord {
  return { kind, marketId: "m", tokenId, connectionEpoch: epoch, envelopeId: `env-${id}`, sequenceInEnvelope: 0, sourceTsMs: id, receivedTsMs: id, createdAtMs: id, payload: { id, nested: { value: id } } };
}

describe("bounded pair capture queue", () => {
  it("is bounded, fails continuity closed on overflow, and rejects subsequent deltas", () => {
    const lost = vi.fn();
    const queue = new PairCaptureQueue({ capacity: 2, batchSize: 1, persistBatch: async () => {}, onContinuityLost: lost });
    queue.registerMarket("m", "up", "down");
    expect(queue.enqueue(record(1))).toBe("ENQUEUED");
    expect(queue.enqueue(record(2))).toBe("ENQUEUED");
    expect(queue.enqueue(record(3))).toBe("OVERFLOW");
    expect(queue.enqueue(record(4))).toBe("CONTINUITY_UNHEALTHY");
    expect(queue.metrics()).toMatchObject({ depth: 2, maxDepth: 2, overflows: 1, rejectedWhileUnhealthy: 1, unhealthyMarketCount: 1 });
    expect(lost).toHaveBeenCalledWith("m", "PAIR_CAPTURE_QUEUE_OVERFLOW");
  });

  it("deep-copies and freezes records before asynchronous persistence", async () => {
    const persisted: Array<readonly PairMarketDataRecord[]> = [];
    const queue = new PairCaptureQueue({ capacity: 2, batchSize: 2, persistBatch: async (batch) => { persisted.push(batch); }, onContinuityLost: () => {} });
    const source = record(1) as { payload: { id: number; nested: { value: number } } } & PairMarketDataRecord;
    queue.enqueue(source);
    source.payload.nested.value = 99;
    await queue.flushAll();
    expect(persisted[0]![0]!.payload).toEqual({ id: 1, nested: { value: 1 } });
    expect(Object.isFrozen(persisted[0]![0]!.payload)).toBe(true);
  });

  it("retains an exact batch when persistence fails", async () => {
    let fail = true;
    const stored: PairMarketDataRecord[] = [];
    const queue = new PairCaptureQueue({ capacity: 3, batchSize: 2, persistBatch: async (batch) => { if (fail) throw new Error("db down"); stored.push(...batch); }, onContinuityLost: () => {} });
    queue.enqueue(record(1)); queue.enqueue(record(2));
    await expect(queue.flushOneBatch()).rejects.toThrow("db down");
    expect(queue.metrics()).toMatchObject({ depth: 2, flushed: 0 });
    fail = false;
    expect(await queue.flushOneBatch()).toBe(2);
    expect(stored.map((r) => r.payload.id)).toEqual([1, 2]);
  });

  it("restores continuity only after persisted UP and DOWN snapshots in the same epoch", async () => {
    const queue = new PairCaptureQueue({ capacity: 2, batchSize: 2, persistBatch: async () => {}, onContinuityLost: () => {} });
    queue.registerMarket("m", "up", "down");
    queue.enqueue(record(1)); queue.enqueue(record(2));
    expect(queue.enqueue(record(3))).toBe("OVERFLOW");
    await queue.flushAll();
    expect(queue.enqueue(record(4, "SNAPSHOT", "up", "e2"))).toBe("ENQUEUED");
    await queue.flushAll();
    expect(queue.isContinuityHealthy("m")).toBe(false);
    expect(queue.enqueue(record(5, "SNAPSHOT", "down", "e1"))).toBe("ENQUEUED");
    await queue.flushAll();
    expect(queue.isContinuityHealthy("m")).toBe(false);
    expect(queue.enqueue(record(6, "SNAPSHOT", "up", "e1"))).toBe("ENQUEUED");
    await queue.flushAll();
    expect(queue.isContinuityHealthy("m")).toBe(true);
  });

  it("flushes in configured batches and records latency metrics", async () => {
    let clock = 10;
    const sizes: number[] = [];
    const queue = new PairCaptureQueue({ capacity: 5, batchSize: 2, persistBatch: async (batch) => { sizes.push(batch.length); clock += 7; }, onContinuityLost: () => {}, nowMs: () => clock });
    queue.enqueue(record(1)); queue.enqueue(record(2)); queue.enqueue(record(3));
    expect(await queue.flushAll()).toBe(3);
    expect(sizes).toEqual([2, 1]);
    expect(queue.metrics()).toMatchObject({ depth: 0, flushed: 3, flushes: 2, lastFlushLatencyMs: 7 });
  });

  it("never splits a complete envelope across persistence batches", async () => {
    const batches: Array<readonly PairMarketDataRecord[]> = [];
    const queue = new PairCaptureQueue({ capacity: 6, batchSize: 2, persistBatch: async (batch) => { batches.push(batch); }, onContinuityLost: () => {} });
    const envelope = [
      { ...record(1), envelopeId: "whole", sequenceInEnvelope: 0 },
      { ...record(2), envelopeId: "whole", sequenceInEnvelope: 1 },
      { ...record(3, "ENVELOPE_BOUNDARY", null), envelopeId: "whole", sequenceInEnvelope: 2 },
    ];
    expect(queue.enqueueEnvelope(envelope)).toBe("ENQUEUED");
    expect(await queue.flushOneBatch()).toBe(3);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((item) => item.sequenceInEnvelope)).toEqual([0, 1, 2]);
  });
});

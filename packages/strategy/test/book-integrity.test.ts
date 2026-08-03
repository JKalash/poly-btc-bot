/**
 * BPAIR-010/011 — connection epoch, integrity transitions, atomic envelope
 * application, and immutable deep snapshots (spec §10.3, §12, §24.7 book-level
 * rows, §24.8 book-level atomicity). Capture-level rows (age/skew gates, pair
 * eligibility, hash-chain verifier fixtures) belong to the capture layer.
 */
import { describe, expect, it } from "vitest";
import {
  BookState,
  canonicalBookHash,
  canonicalBookSerialization,
  isObserverEligibleIntegrity,
  isPaperEligibleIntegrity,
  type ImmutableBookView,
} from "../src/index";

const L = (price: string, size: string) => ({ price, size });

/** Book wired the way the engine will be: epoch signalled first, then a fresh snapshot in that epoch. */
function verifiedBook(epoch = "E1"): BookState {
  const b = new BookState("tok-up", "mkt-1");
  b.invalidateForReconnect(epoch);
  b.applySnapshot(
    [L("0.40", "10"), L("0.35", "20")],
    [L("0.45", "5"), L("0.50", "20")],
    1000, 1010,
    { connectionEpoch: epoch, exchangeHash: "xh-snap", sourceEventId: "snap-1" },
  );
  return b;
}

describe("fail-closed initial state (§12.1: delta before initial snapshot -> book invalid)", () => {
  it("starts INVALID_AFTER_RECONNECT with bookVersion 0", () => {
    const b = new BookState("t");
    expect(b.integrity).toBe("INVALID_AFTER_RECONNECT");
    expect(b.bookVersion).toBe(0n);
    expect(isPaperEligibleIntegrity(b.integrity)).toBe(false);
    expect(isObserverEligibleIntegrity(b.integrity)).toBe(false);
  });

  it("a delta before the initial snapshot never revives the book (both paths)", () => {
    const b = new BookState("t");
    b.applyLevelUpdate("0.40", "5", "BUY", 100, 110);
    expect(b.integrity).toBe("INVALID_AFTER_RECONNECT");
    const out = b.applyEnvelope([L2("0.41", "5", "BUY")], 200, 210);
    expect(out).toBe("APPLIED_WHILE_INVALID");
    expect(b.integrity).toBe("INVALID_AFTER_RECONNECT");
    // levels ARE retained — diagnostics only, never eligibility (§12.3)
    expect(b.bids.get(410_000n)).toBe(5_000_000n);
  });
});

function L2(price: string, size: string, side: "BUY" | "SELL") {
  return { price, size, side };
}

describe("snapshot readiness and reconnect barrier (§12.3, §24.7 book rows)", () => {
  it("fresh full snapshot -> VERIFIED_SNAPSHOT with epoch and provenance", () => {
    const b = verifiedBook("E1");
    expect(b.integrity).toBe("VERIFIED_SNAPSHOT");
    expect(b.connectionEpoch).toBe("E1");
    expect(b.exchangeHash).toBe("xh-snap");
    expect(b.sourceEventId).toBe("snap-1");
    expect(isPaperEligibleIntegrity(b.integrity)).toBe(true);
  });

  it("reconnect invalidates immediately; old levels stay in memory but are never eligible", () => {
    const b = verifiedBook("E1");
    const vBefore = b.bookVersion;
    b.invalidateForReconnect("E2");
    expect(b.integrity).toBe("INVALID_AFTER_RECONNECT");
    expect(b.connectionEpoch).toBe("E2");
    expect(b.bookVersion).toBe(vBefore + 1n);
    expect(b.bestBid()).toBe(400_000n); // diagnostics retained
    expect(isObserverEligibleIntegrity(b.integrity)).toBe(false);
  });

  it("a delta in the new epoch before the new snapshot does not revive the book", () => {
    const b = verifiedBook("E1");
    b.invalidateForReconnect("E2");
    const out = b.applyEnvelope([L2("0.42", "3", "BUY")], 2000, 2010, { connectionEpoch: "E2" });
    expect(out).toBe("APPLIED_WHILE_INVALID");
    expect(b.integrity).toBe("INVALID_AFTER_RECONNECT");
    b.applyLevelUpdate("0.43", "3", "BUY", 2100, 2110); // legacy path also never revives
    expect(b.integrity).toBe("INVALID_AFTER_RECONNECT");
  });

  it("a stale snapshot from the OLD epoch does not restore validity", () => {
    const b = verifiedBook("E1");
    b.invalidateForReconnect("E2");
    b.applySnapshot([L("0.30", "1")], [L("0.70", "1")], 3000, 3010, { connectionEpoch: "E1" });
    expect(b.integrity).toBe("INVALID_AFTER_RECONNECT");
    expect(b.connectionEpoch).toBe("E2"); // belief unchanged; stale data is diagnostics
  });

  it("an epoch-aware book rejects a snapshot with NO epoch metadata (fail closed)", () => {
    const b = verifiedBook("E1");
    b.invalidateForReconnect("E2");
    b.applySnapshot([L("0.30", "1")], [L("0.70", "1")], 3000, 3010);
    expect(b.integrity).toBe("INVALID_AFTER_RECONNECT");
  });

  it("a fresh full snapshot in the NEW epoch restores VERIFIED_SNAPSHOT", () => {
    const b = verifiedBook("E1");
    b.invalidateForReconnect("E2");
    b.applySnapshot([L("0.30", "1")], [L("0.70", "1")], 3000, 3010, { connectionEpoch: "E2", sourceEventId: "snap-2" });
    expect(b.integrity).toBe("VERIFIED_SNAPSHOT");
    expect(b.connectionEpoch).toBe("E2");
  });

  it("a delta stamped with a different epoch on a valid book invalidates and is NOT applied", () => {
    const b = verifiedBook("E1");
    const out = b.applyEnvelope([L2("0.44", "9", "BUY")], 2000, 2010, { connectionEpoch: "E2" });
    expect(out).toBe("REJECTED_EPOCH_MISMATCH");
    expect(b.integrity).toBe("INVALID_AFTER_RECONNECT");
    expect(b.bids.has(440_000n)).toBe(false); // no cross-epoch franken-book
  });

  it("legacy mode (never epoch-signalled): snapshot without meta still verifies, epoch stays \"\"", () => {
    const b = new BookState("t");
    b.applySnapshot([L("0.40", "1")], [L("0.60", "1")], 1000, 1010);
    expect(b.integrity).toBe("VERIFIED_SNAPSHOT");
    expect(b.connectionEpoch).toBe(""); // will never match a real ws epoch -> pair layer rejects
  });
});

describe("envelope atomicity (§12.2, §24.8 book-level)", () => {
  it("applies all changes as one unit: bookVersion +1 exactly, timestamps stamped once", () => {
    const b = verifiedBook("E1");
    const vBefore = b.bookVersion;
    // change 1 alone would put a crossed/synthetic best ask at 0.30; change 2 removes it.
    const out = b.applyEnvelope(
      [L2("0.30", "50", "SELL"), L2("0.30", "0", "SELL")],
      5000, 5040,
      { connectionEpoch: "E1", sourceEventId: "pc-1", exchangeHash: "h-pc-1" },
    );
    expect(out).toBe("APPLIED");
    // exactly one version increment -> no intermediate version ever existed to observe/capture
    expect(b.bookVersion).toBe(vBefore + 1n);
    expect(b.asks.has(300_000n)).toBe(false); // both changes present in the final state
    expect(b.sourceTsMs).toBe(5000);
    expect(b.receivedTsMs).toBe(5040);
    expect(b.exchangeHash).toBe("h-pc-1");
    expect(b.sourceEventId).toBe("pc-1");
  });

  it("the legacy per-level path bumps the version PER level — evidence of its non-atomicity", () => {
    const b = verifiedBook("E1");
    const vBefore = b.bookVersion;
    b.applyLevelUpdate("0.30", "50", "SELL", 5000, 5040);
    b.applyLevelUpdate("0.30", "0", "SELL", 5000, 5041);
    expect(b.bookVersion).toBe(vBefore + 2n); // torn intermediate state was observable
  });

  it("an unsequenced delta demotes VERIFIED_SNAPSHOT to UNSEQUENCED_AFTER_SNAPSHOT (§12.1)", () => {
    const env = verifiedBook("E1");
    env.applyEnvelope([L2("0.41", "1", "BUY")], 2000, 2010, { connectionEpoch: "E1" });
    expect(env.integrity).toBe("UNSEQUENCED_AFTER_SNAPSHOT");
    expect(isPaperEligibleIntegrity(env.integrity)).toBe(false); // observer-only
    expect(isObserverEligibleIntegrity(env.integrity)).toBe(true);

    const legacy = verifiedBook("E1");
    legacy.applyLevelUpdate("0.41", "1", "BUY", 2000, 2010);
    expect(legacy.integrity).toBe("UNSEQUENCED_AFTER_SNAPSHOT");
  });

  it("a local canonical hash never upgrades continuity (§12.4)", () => {
    const b = verifiedBook("E1");
    b.applyEnvelope([L2("0.41", "1", "BUY")], 2000, 2010, { connectionEpoch: "E1" });
    const before = b.integrity;
    canonicalBookHash(b.snapshot());
    expect(b.integrity).toBe(before);
    expect(b.integrity).toBe("UNSEQUENCED_AFTER_SNAPSHOT");
  });
});

describe("duplicates, sequences, and timestamp regressions (§12.5, §24.7 rows)", () => {
  it("duplicate source event with identical hash: ignored but counted, no mutation", () => {
    const b = verifiedBook("E1");
    b.applyEnvelope([L2("0.41", "7", "BUY")], 2000, 2010, { connectionEpoch: "E1", sourceEventId: "e1", exchangeHash: "h1" });
    const v = b.bookVersion;
    const out = b.applyEnvelope([L2("0.41", "999", "BUY")], 2001, 2011, { connectionEpoch: "E1", sourceEventId: "e1", exchangeHash: "h1" });
    expect(out).toBe("DUPLICATE_IGNORED");
    expect(b.bookVersion).toBe(v); // idempotent — nothing mutated
    expect(b.bids.get(410_000n)).toBe(7_000_000n);
    expect(b.duplicateIgnoredCount).toBe(1);
    expect(b.integrity).toBe("UNSEQUENCED_AFTER_SNAPSHOT");
  });

  it("duplicate id with a DIFFERENT payload hash: invalidate (GAP_SUSPECTED) and count", () => {
    const b = verifiedBook("E1");
    b.applyEnvelope([L2("0.41", "7", "BUY")], 2000, 2010, { connectionEpoch: "E1", sourceEventId: "e1", exchangeHash: "h1" });
    const out = b.applyEnvelope([L2("0.41", "999", "BUY")], 2001, 2011, { connectionEpoch: "E1", sourceEventId: "e1", exchangeHash: "h2" });
    expect(out).toBe("REJECTED_DUPLICATE_PAYLOAD_MISMATCH");
    expect(b.integrity).toBe("GAP_SUSPECTED");
    expect(b.duplicatePayloadMismatchCount).toBe(1);
    expect(b.bids.get(410_000n)).toBe(7_000_000n); // rejected payload not applied
  });

  it("sequence regression invalidates until a new snapshot restores", () => {
    const b = verifiedBook("E1");
    b.applyEnvelope([L2("0.41", "7", "BUY")], 2000, 2010, { connectionEpoch: "E1", sourceSequence: 5n });
    const out = b.applyEnvelope([L2("0.42", "7", "BUY")], 2002, 2012, { connectionEpoch: "E1", sourceSequence: 4n });
    expect(out).toBe("REJECTED_SEQUENCE_REGRESSION");
    expect(b.integrity).toBe("GAP_SUSPECTED");
    expect(b.sequenceRegressionCount).toBe(1);
    // deltas never restore from GAP_SUSPECTED
    expect(b.applyEnvelope([L2("0.42", "7", "BUY")], 2003, 2013, { connectionEpoch: "E1", sourceSequence: 6n })).toBe("APPLIED_WHILE_INVALID");
    expect(b.integrity).toBe("GAP_SUSPECTED");
    // a fresh full snapshot in the CURRENT epoch restores
    b.applySnapshot([L("0.40", "1")], [L("0.60", "1")], 3000, 3010, { connectionEpoch: "E1" });
    expect(b.integrity).toBe("VERIFIED_SNAPSHOT");
  });

  it("sequences are never invented and never upgrade: contiguous sequences still yield UNSEQUENCED_AFTER_SNAPSHOT", () => {
    const b = verifiedBook("E1");
    b.applyEnvelope([L2("0.41", "1", "BUY")], 2000, 2010, { connectionEpoch: "E1", sourceSequence: 1n });
    b.applyEnvelope([L2("0.42", "1", "BUY")], 2001, 2011, { connectionEpoch: "E1", sourceSequence: 2n });
    // no documented venue sequence contract -> continuity evidence is never overstated (§12.1)
    expect(b.integrity).toBe("UNSEQUENCED_AFTER_SNAPSHOT");
  });

  it("timestamp regression without tolerance: recorded, still applied in receive order", () => {
    const b = verifiedBook("E1");
    const out = b.applyEnvelope([L2("0.41", "1", "BUY")], 900, 2010, { connectionEpoch: "E1" }); // sourceTs regresses 1000 -> 900
    expect(out).toBe("APPLIED");
    expect(b.timestampRegressionCount).toBe(1);
    expect(b.sourceTsMs).toBe(900); // local receive order remains the causal order
  });

  it("timestamp regression beyond the configured tolerance invalidates; exactly-at-tolerance applies", () => {
    const atLimit = verifiedBook("E1");
    atLimit.timestampRegressionToleranceMs = 100;
    expect(atLimit.applyEnvelope([L2("0.41", "1", "BUY")], 900, 2010, { connectionEpoch: "E1" })).toBe("APPLIED"); // regression == 100
    const beyond = verifiedBook("E1");
    beyond.timestampRegressionToleranceMs = 100;
    const out = beyond.applyEnvelope([L2("0.41", "1", "BUY")], 899, 2010, { connectionEpoch: "E1" }); // regression == 101
    expect(out).toBe("REJECTED_TIMESTAMP_REGRESSION");
    expect(beyond.integrity).toBe("GAP_SUSPECTED");
    expect(beyond.bids.has(410_000n)).toBe(false);
  });
});

describe("immutable deep snapshots and canonical hashing (§10.3, §12.4, BPAIR-011)", () => {
  it("snapshot is recursively frozen and detached from the live maps", () => {
    const b = verifiedBook("E1");
    const v = b.snapshot();
    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(v.bids)).toBe(true);
    expect(Object.isFrozen(v.asks)).toBe(true);
    expect(Object.isFrozen(v.bids[0])).toBe(true);
    expect(() => { (v as { bids: unknown }).bids = []; }).toThrow();
    expect(() => { (v.bids as unknown as unknown[]).push({}); }).toThrow();
    expect(() => { (v.bids[0] as { price: bigint }).price = 0n; }).toThrow();
  });

  it("levels are sorted and positive-size only: bids descending, asks ascending", () => {
    const b = new BookState("t", "m");
    b.applySnapshot(
      [L("0.35", "20"), L("0.40", "10"), L("0.20", "0")],
      [L("0.50", "20"), L("0.45", "5")],
      1000, 1010, { connectionEpoch: "E1" },
    );
    const v = b.snapshot();
    expect(v.bids.map((l) => l.price)).toEqual([400_000n, 350_000n]); // zero-size level excluded
    expect(v.asks.map((l) => l.price)).toEqual([450_000n, 500_000n]);
  });

  it("a later mutation of the live book changes neither a prior view's levels nor its hash", () => {
    const b = verifiedBook("E1");
    const v1 = b.snapshot();
    const bidsCopy = v1.bids.map((l) => ({ price: l.price, size: l.size }));
    const hash1 = canonicalBookHash(v1);
    b.applyEnvelope([L2("0.40", "999", "BUY"), L2("0.45", "0", "SELL")], 9000, 9010, { connectionEpoch: "E1" });
    b.applySnapshot([L("0.10", "1")], [L("0.90", "1")], 9500, 9510, { connectionEpoch: "E1" });
    b.invalidateForReconnect("E2");
    expect(v1.bids.map((l) => ({ price: l.price, size: l.size }))).toEqual(bidsCopy);
    expect(v1.bookVersion).not.toBe(b.bookVersion);
    expect(v1.integrity).toBe("VERIFIED_SNAPSHOT");
    expect(canonicalBookHash(v1)).toBe(hash1);
  });

  it("carries all provenance fields per §10.3", () => {
    const b = verifiedBook("E1");
    const v = b.snapshot();
    expect(v.tokenId).toBe("tok-up");
    expect(v.marketId).toBe("mkt-1");
    expect(v.connectionEpoch).toBe("E1");
    expect(v.bookVersion).toBe(b.bookVersion);
    expect(v.sourceTsMs).toBe(1000);
    expect(v.receivedTsMs).toBe(1010);
    expect(v.exchangeHash).toBe("xh-snap");
    expect(v.sourceEventId).toBe("snap-1");
    expect(v.integrity).toBe("VERIFIED_SNAPSHOT");
  });

  it("canonical serialization: sorted keys, normative field order, bigints as base-10 strings", () => {
    const b = verifiedBook("E1");
    const s = canonicalBookSerialization(b.snapshot());
    const order = ["\"asks\":", "\"bids\":", "\"bookVersion\":", "\"connectionEpoch\":", "\"exchangeHash\":", "\"integrity\":", "\"marketId\":", "\"receivedTsMs\":", "\"sourceEventId\":", "\"sourceTsMs\":", "\"tokenId\":"];
    let last = -1;
    for (const key of order) {
      const idx = s.indexOf(key);
      expect(idx, `field ${key} present and ordered`).toBeGreaterThan(last);
      last = idx;
    }
    expect(s).toContain('{"price":"400000","size":"10000000"}');
    expect(s.startsWith("{\"asks\":[")).toBe(true);
    // deterministic: identical state -> byte-identical serialization
    expect(canonicalBookSerialization(verifiedBook("E1").snapshot())).toBe(s);
    expect(canonicalBookHash(verifiedBook("E1").snapshot())).toBe(canonicalBookHash(b.snapshot()));
  });

  it("bigint round trip is exact beyond Number.MAX_SAFE_INTEGER; one base-unit difference changes the hash", () => {
    const mk = (size: string) => {
      const b = new BookState("t", "m");
      b.applySnapshot([L("0.999999", size)], [], 1000, 1010, { connectionEpoch: "E1" });
      return b.snapshot();
    };
    const big = mk("123456789012345.678901"); // 123456789012345678901 base units > 2^53
    expect(big.bids[0]!.size).toBe(123_456_789_012_345_678_901n);
    const parsed = JSON.parse(canonicalBookSerialization(big)) as { bids: Array<{ price: string; size: string }> };
    expect(BigInt(parsed.bids[0]!.size)).toBe(123_456_789_012_345_678_901n);
    expect(BigInt(parsed.bids[0]!.price)).toBe(999_999n);
    const offByOne = mk("123456789012345.678902");
    expect(canonicalBookHash(offByOne)).not.toBe(canonicalBookHash(big));
  });

  it("null exchangeHash serializes as JSON null and hashes stably", () => {
    const b = new BookState("t", "m");
    b.applySnapshot([L("0.40", "1")], [L("0.60", "1")], 1000, 1010, { connectionEpoch: "E1" });
    const v = b.snapshot();
    expect(v.exchangeHash).toBeNull();
    expect(canonicalBookSerialization(v)).toContain('"exchangeHash":null');
    expect(canonicalBookHash(v)).toBe(canonicalBookHash(b.snapshot()));
  });

  it("applyTrade is telemetry only: no version bump, view/hash unchanged", () => {
    const b = verifiedBook("E1");
    const v1 = b.snapshot();
    const h1 = canonicalBookHash(v1);
    b.applyTrade("0.42", 9000);
    expect(b.bookVersion).toBe(v1.bookVersion);
    expect(canonicalBookHash(b.snapshot())).toBe(h1);
  });
});

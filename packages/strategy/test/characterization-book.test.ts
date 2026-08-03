/**
 * BPAIR-002 characterization tests — packages/strategy BookState.
 *
 * These tests PIN current behavior (spec §25.2 Phase 0) so accidental changes
 * under the pair work are caught. Fragile/surprising behavior is pinned with
 * an explanatory comment, NOT fixed. Plain vitest only (fast-check is not a
 * strategy devDependency).
 */
import { describe, expect, it } from "vitest";
import { BookState, complementConsistency } from "../src/index";

function seeded(): BookState {
  const b = new BookState("tok-up");
  b.applySnapshot(
    [{ price: "0.40", size: "10" }, { price: "0.35", size: "20" }],
    [{ price: "0.40", size: "10" }, { price: "0.45", size: "5" }, { price: "0.50", size: "20" }],
    1000, 1010,
  );
  return b;
}

describe("applySnapshot characterization", () => {
  it("replaces ALL prior state — no merging with the previous book", () => {
    const b = seeded();
    b.applySnapshot([{ price: "0.30", size: "1" }], [{ price: "0.31", size: "2" }], 2000, 2010);
    expect(b.sortedBids()).toEqual([{ price: 300_000n, size: 1_000_000n }]);
    expect(b.sortedAsks()).toEqual([{ price: 310_000n, size: 2_000_000n }]);
    expect(b.bestBid()).toBe(300_000n);
    expect(b.bestAsk()).toBe(310_000n);
    expect(b.sourceTsMs).toBe(2000);
    expect(b.receivedTsMs).toBe(2010);
  });

  it("stores zero-size snapshot levels in the raw map, but best/sorted views hide them", () => {
    // PINNED: applySnapshot does NOT filter size-0 levels (applyLevelUpdate
    // does delete them). The zero-size row occupies the map and is returned
    // by queueAtBid as 0n, indistinguishable from an absent level.
    const b = new BookState("t");
    b.applySnapshot([{ price: "0.50", size: "0" }, { price: "0.49", size: "3" }], [], 1000, 1000);
    expect(b.bids.size).toBe(2); // raw map keeps the empty level
    expect(b.bestBid()).toBe(490_000n);
    expect(b.sortedBids()).toEqual([{ price: 490_000n, size: 3_000_000n }]);
    expect(b.queueAtBid(500_000n)).toBe(0n);
  });

  it("size strings beyond 6 decimals are TRUNCATED, not rounded and not rejected", () => {
    const b = new BookState("t");
    b.applySnapshot([{ price: "0.50", size: "1.1234567" }], [], 1000, 1000);
    expect(b.queueAtBid(500_000n)).toBe(1_123_456n); // trailing 7 silently dropped
  });

  it("negative sizes are rejected loudly", () => {
    const b = new BookState("t");
    expect(() => b.applySnapshot([{ price: "0.50", size: "-1" }], [], 1000, 1000)).toThrow("bad size");
  });

  it("prices outside [0,1] are rejected by prob()", () => {
    const b = new BookState("t");
    expect(() => b.applySnapshot([{ price: "1.5", size: "1" }], [], 1000, 1000)).toThrow();
  });
});

describe("applyLevelUpdate characterization (torn-book reality)", () => {
  it("updates exactly one level per call; size 0 removes the level", () => {
    const b = seeded();
    b.applyLevelUpdate("0.45", "7", "SELL", 2000, 2010);
    expect(b.asks.get(450_000n)).toBe(7_000_000n);
    expect(b.asks.get(500_000n)).toBe(20_000_000n); // untouched sibling level
    b.applyLevelUpdate("0.45", "0", "SELL", 3000, 3010);
    expect(b.asks.has(450_000n)).toBe(false);
  });

  it("PINNED: each level update restamps the WHOLE book's timestamps", () => {
    // There is no per-level timestamp. After a single level update the entire
    // book presents as fresh (ageMs computed from receivedTsMs) even though
    // every other level is still from the older snapshot. A partially-updated
    // ("torn") book is therefore indistinguishable from a fully-fresh one.
    // The pair subsystem must not assume book-wide freshness from these
    // fields — this is why it must persist complete book evidence itself.
    const b = seeded();
    expect(b.sourceTsMs).toBe(1000);
    b.applyLevelUpdate("0.45", "7", "SELL", 5000, 5040);
    expect(b.sourceTsMs).toBe(5000);
    expect(b.receivedTsMs).toBe(5040);
    expect(b.ageMs(5050)).toBe(10); // whole book claims 10ms age
    expect(b.asks.get(500_000n)).toBe(20_000_000n); // yet this level is from ts=1000
  });

  it("ageMs is null until any snapshot/update has been received", () => {
    const b = new BookState("t");
    expect(b.ageMs(123_456)).toBeNull();
    b.applySnapshot([], [], 1000, 1010);
    expect(b.ageMs(1500)).toBe(490);
  });
});

describe("sorted views and top-of-book characterization", () => {
  it("sortedBids is strictly descending by price; sortedAsks strictly ascending", () => {
    const b = new BookState("t");
    b.applySnapshot(
      [{ price: "0.35", size: "20" }, { price: "0.40", size: "10" }, { price: "0.20", size: "5" }],
      [{ price: "0.50", size: "20" }, { price: "0.45", size: "5" }, { price: "0.60", size: "1" }],
      1000, 1000,
    );
    expect(b.sortedBids().map((l) => l.price)).toEqual([400_000n, 350_000n, 200_000n]);
    expect(b.sortedAsks().map((l) => l.price)).toEqual([450_000n, 500_000n, 600_000n]);
  });

  it("spread and mid; mid uses bigint floor division", () => {
    const b = new BookState("t");
    b.applySnapshot([{ price: "0.550001", size: "1" }], [{ price: "0.56", size: "1" }], 1000, 1000);
    expect(b.spread()).toBe(9_999n);
    // (550001 + 560000) / 2 = 555000.5 -> floor 555000 (bigint division)
    expect(b.mid()).toBe(555_000n);
    expect(new BookState("x").mid()).toBeNull();
    expect(new BookState("x").spread()).toBeNull();
  });

  it("queueAtBid returns the exact displayed size at that price, 0n when absent, bid-side only", () => {
    const b = seeded();
    expect(b.queueAtBid(400_000n)).toBe(10_000_000n);
    expect(b.queueAtBid(350_000n)).toBe(20_000_000n);
    expect(b.queueAtBid(410_000n)).toBe(0n);
    expect(b.queueAtBid(450_000n)).toBe(0n); // 0.45 exists only on the ask side
  });

  it("quoteFlipCount: no flip counted for the first observed best; changes after that count", () => {
    const b = new BookState("t");
    b.applySnapshot([{ price: "0.40", size: "1" }], [{ price: "0.45", size: "1" }], 1000, 1000);
    expect(b.quoteFlipCount).toBe(0); // first best established, not a flip
    b.applySnapshot([{ price: "0.41", size: "1" }], [{ price: "0.45", size: "1" }], 1100, 1100);
    expect(b.quoteFlipCount).toBe(1); // best bid moved
    b.applyLevelUpdate("0.30", "9", "BUY", 1200, 1200); // deep level, best unchanged
    expect(b.quoteFlipCount).toBe(1);
  });

  it("applyTrade updates trade fields only — book timestamps untouched", () => {
    const b = seeded();
    b.applyTrade("0.42", 9000);
    expect(b.lastTradePrice6).toBe(420_000n);
    expect(b.lastTradeTsMs).toBe(9000);
    expect(b.sourceTsMs).toBe(1000);
    expect(b.receivedTsMs).toBe(1010);
  });
});

describe("takerBuyImpact characterization (ask-walk semantics)", () => {
  function asksOnly(): BookState {
    const b = new BookState("t");
    b.applySnapshot(
      [],
      [{ price: "0.40", size: "10" }, { price: "0.45", size: "5" }, { price: "0.50", size: "20" }],
      1000, 1000,
    );
    return b;
  }

  it("multi-level walk: exact avg (floor-divided), worst, and impact", () => {
    // buy 12: 10 @ 0.40 + 2 @ 0.45; cost6 = 400000*10e6 + 450000*2e6 = 4.9e12
    // avg = 4.9e12 / 12e6 = 408333.33... -> bigint floor 408333
    const r = asksOnly().takerBuyImpact(12_000_000n);
    expect(r).toEqual({ avgPrice6: 408_333n, worstPrice6: 450_000n, impact6: 8_333n });
  });

  it("walking the entire book exactly: avg floor, worst = deepest touched level", () => {
    // buy 35 (all): cost = 4 + 2.25 + 10 = 16.25 USDC; avg = 16.25/35 = 0.4642857...
    const r = asksOnly().takerBuyImpact(35_000_000n);
    expect(r).toEqual({ avgPrice6: 464_285n, worstPrice6: 500_000n, impact6: 64_285n });
  });

  it("single-level exact fill has zero impact", () => {
    const r = asksOnly().takerBuyImpact(10_000_000n);
    expect(r).toEqual({ avgPrice6: 400_000n, worstPrice6: 400_000n, impact6: 0n });
  });

  it("PINNED: null when the book cannot fill the size — no partial answer", () => {
    expect(asksOnly().takerBuyImpact(35_000_001n)).toBeNull();
  });

  it("null for size <= 0 and for an empty ask side", () => {
    expect(asksOnly().takerBuyImpact(0n)).toBeNull();
    expect(asksOnly().takerBuyImpact(-1n)).toBeNull();
    expect(new BookState("x").takerBuyImpact(1_000_000n)).toBeNull();
  });

  it("PINNED: there is no limit-price parameter — the walk crosses every level needed", () => {
    // buy 30: takes 10@0.40 + 5@0.45 + 15@0.50 regardless of how deep 0.50 is
    // relative to top. Callers wanting a limit must enforce it themselves.
    const r = asksOnly().takerBuyImpact(30_000_000n);
    expect(r!.worstPrice6).toBe(500_000n);
  });
});

describe("complementConsistency characterization", () => {
  it("|1 - (UP bid + DOWN ask)| as a FLOAT (display metric, not economics)", () => {
    const up = new BookState("u");
    up.applySnapshot([{ price: "0.45", size: "1" }], [{ price: "0.47", size: "1" }], 1000, 1000);
    const down = new BookState("d");
    down.applySnapshot([{ price: "0.54", size: "1" }], [{ price: "0.56", size: "1" }], 1000, 1000);
    // 0.45 + 0.56 = 1.01 -> deviation 0.01 (subject to float representation)
    expect(complementConsistency(up, down)!).toBeCloseTo(0.01, 9);
  });

  it("perfect complement gives exactly 0", () => {
    const up = new BookState("u");
    up.applySnapshot([{ price: "0.45", size: "1" }], [], 1000, 1000);
    const down = new BookState("d");
    down.applySnapshot([], [{ price: "0.55", size: "1" }], 1000, 1000);
    expect(complementConsistency(up, down)).toBe(0);
  });

  it("null when either side of the comparison is missing", () => {
    const up = new BookState("u");
    up.applySnapshot([{ price: "0.45", size: "1" }], [], 1000, 1000);
    expect(complementConsistency(up, new BookState("d"))).toBeNull();
    expect(complementConsistency(new BookState("u2"), up)).toBeNull(); // up2 has no bid
  });
});

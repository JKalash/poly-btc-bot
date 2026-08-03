/**
 * BPAIR-002 characterization tests for packages/strategy/src/book.ts.
 *
 * BookState is a MUTABLE per-token L2 book. Wave-3 work (epochs, immutable
 * snapshots — BPAIR-010/011) will refactor around it; these tests pin today's
 * semantics so that refactor cannot silently change them.
 *
 * Quirks pinned (current behavior, not endorsements):
 *  - applySnapshot STORES zero-size levels in the map (only readers filter
 *    them out); applyLevelUpdate with size "0" DELETES the level instead.
 *  - Level sizes with more than 6 decimals are silently TRUNCATED by
 *    parseSize (no throw, no rounding) — unlike prices, which go through
 *    prob() and throw outside [0,1] or beyond 6 decimals.
 *  - Crossed books are accepted without complaint: bestBid > bestAsk yields a
 *    negative spread() and mid() truncates toward zero on odd sums.
 *  - takerBuyImpact's average price is a TRUNCATING division (floor).
 *  - quoteFlipCount only counts changes while the previous best BID was
 *    non-null; while the bid side is empty, ask-side flips go uncounted.
 *  - Timestamps update on EVERY applySnapshot/applyLevelUpdate, including
 *    no-op deletes of absent levels.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { prob } from "@b5p/domain";
import { BookState, complementConsistency } from "../src/index";

// fixed test timeline (repo idiom)
const START = 1_785_500_100_000;

function freshBook(): BookState {
  const b = new BookState("tok-up");
  b.applySnapshot(
    [{ price: "0.55", size: "500" }, { price: "0.50", size: "800" }],
    [{ price: "0.56", size: "400" }, { price: "0.60", size: "700" }, { price: "0.65", size: "900" }],
    START, START + 30,
  );
  return b;
}

describe("applySnapshot characterization", () => {
  it("replaces the whole book and parses sizes to micro-shares", () => {
    const b = freshBook();
    expect(b.bestBid()).toBe(prob("0.55"));
    expect(b.bestAsk()).toBe(prob("0.56"));
    expect(b.bids.get(prob("0.50"))).toBe(800_000_000n);
    b.applySnapshot([{ price: "0.40", size: "1" }], [], START + 1000, START + 1030);
    expect(b.bids.size).toBe(1); // old levels cleared
    expect(b.bestBid()).toBe(prob("0.40"));
    expect(b.bestAsk()).toBe(null);
  });

  it("duplicate prices in one snapshot: last level wins (Map.set)", () => {
    const b = new BookState("t");
    b.applySnapshot([{ price: "0.55", size: "100" }, { price: "0.55", size: "200" }], [], START, START);
    expect(b.bids.size).toBe(1);
    expect(b.bids.get(prob("0.55"))).toBe(200_000_000n);
  });

  it("QUIRK: zero-size snapshot levels are stored in the map but invisible to readers", () => {
    const b = new BookState("t");
    b.applySnapshot([{ price: "0.55", size: "0" }], [{ price: "0.60", size: "0" }], START, START);
    expect(b.bids.size).toBe(1); // stored...
    expect(b.asks.size).toBe(1);
    expect(b.bestBid()).toBe(null); // ...but filtered everywhere else
    expect(b.bestAsk()).toBe(null);
    expect(b.sortedBids()).toEqual([]);
    expect(b.depthTopN("ask", 5)).toBe(0n);
    expect(b.queueAtBid(prob("0.55"))).toBe(0n); // same answer as an absent level
  });

  it("sizes with >6 decimals are silently truncated, never rounded", () => {
    const b = new BookState("t");
    b.applySnapshot([{ price: "0.55", size: "0.1234567" }], [], START, START);
    expect(b.bids.get(prob("0.55"))).toBe(123_456n); // 7th digit dropped
    b.applyLevelUpdate("0.55", "0.9999999", "BUY", START + 1, START + 1);
    expect(b.bids.get(prob("0.55"))).toBe(999_999n);
  });

  it("negative or malformed sizes throw; whitespace is trimmed", () => {
    const b = new BookState("t");
    expect(() => b.applyLevelUpdate("0.55", "-1", "BUY", START, START)).toThrow("bad size");
    expect(() => b.applyLevelUpdate("0.55", "", "BUY", START, START)).toThrow("bad size");
    expect(() => b.applyLevelUpdate("0.55", "1e3", "BUY", START, START)).toThrow("bad size");
    b.applyLevelUpdate("0.55", " 1.5 ", "BUY", START, START);
    expect(b.bids.get(prob("0.55"))).toBe(1_500_000n);
  });

  it("prices outside [0,1] throw via prob(); 0 and 1 are accepted", () => {
    const b = new BookState("t");
    expect(() => b.applyLevelUpdate("1.01", "5", "SELL", START, START)).toThrow("prob out of [0,1]");
    expect(() => b.applyLevelUpdate("-0.01", "5", "BUY", START, START)).toThrow();
    b.applyLevelUpdate("0", "5", "BUY", START, START);
    b.applyLevelUpdate("1", "5", "SELL", START, START);
    expect(b.bestBid()).toBe(0n);
    expect(b.bestAsk()).toBe(1_000_000n);
  });
});

describe("applyLevelUpdate characterization", () => {
  it("sets the NEW absolute size at a level (not a delta); size 0 deletes", () => {
    const b = freshBook();
    b.applyLevelUpdate("0.56", "150", "SELL", START + 100, START + 130);
    expect(b.asks.get(prob("0.56"))).toBe(150_000_000n); // replaced, not 400+150
    b.applyLevelUpdate("0.56", "0", "SELL", START + 200, START + 230);
    expect(b.asks.has(prob("0.56"))).toBe(false); // removed from the map entirely
    expect(b.bestAsk()).toBe(prob("0.60"));
  });

  it("creates levels that were not in the snapshot; sides are independent", () => {
    const b = freshBook();
    b.applyLevelUpdate("0.57", "10", "BUY", START + 100, START + 130);
    expect(b.bids.get(prob("0.57"))).toBe(10_000_000n);
    expect(b.asks.has(prob("0.57"))).toBe(false);
    // same price on both sides can coexist
    b.applyLevelUpdate("0.57", "20", "SELL", START + 200, START + 230);
    expect(b.bids.get(prob("0.57"))).toBe(10_000_000n);
    expect(b.asks.get(prob("0.57"))).toBe(20_000_000n);
  });

  it("QUIRK: timestamps advance on every update, even a no-op delete of an absent level", () => {
    const b = freshBook();
    b.applyLevelUpdate("0.99", "0", "SELL", START + 500, START + 530);
    expect(b.sourceTsMs).toBe(START + 500);
    expect(b.receivedTsMs).toBe(START + 530);
    expect(b.ageMs(START + 1000)).toBe(470);
  });

  it("QUIRK: a crossed book is accepted; spread goes negative and mid truncates", () => {
    const b = freshBook();
    b.applyLevelUpdate("0.60", "100", "BUY", START + 100, START + 130); // bid 0.60 > ask 0.56
    expect(b.bestBid()).toBe(prob("0.60"));
    expect(b.bestAsk()).toBe(prob("0.56"));
    expect(b.spread()).toBe(-40_000n);
    expect(b.mid()).toBe(580_000n);
  });

  it("mid() truncates odd micro-sums toward zero", () => {
    const b = new BookState("t");
    b.applySnapshot([{ price: "0.55", size: "1" }], [{ price: "0.560001", size: "1" }], START, START);
    expect(b.mid()).toBe(555_000n); // (550000 + 560001) / 2 = 555000.5 -> 555000
  });

  it("ageMs is null before any data (receivedTsMs === 0)", () => {
    expect(new BookState("t").ageMs(START)).toBe(null);
  });
});

describe("sorted views and depth", () => {
  it("sortedBids descending, sortedAsks ascending, zero-size filtered", () => {
    const b = freshBook();
    b.bids.set(prob("0.52"), 0n); // simulate a stored zero-size level
    expect(b.sortedBids().map((l) => l.price)).toEqual([prob("0.55"), prob("0.50")]);
    expect(b.sortedAsks().map((l) => l.price)).toEqual([prob("0.56"), prob("0.60"), prob("0.65")]);
    expect(b.depthTopN("bid", 1)).toBe(500_000_000n);
    expect(b.depthTopN("bid", 10)).toBe(1_300_000_000n);
    expect(b.depthTopN("ask", 2)).toBe(1_100_000_000n);
  });

  it("property: after arbitrary updates, best quotes equal extremes of positive-size levels", () => {
    const priceArb = fc.integer({ min: 1, max: 99 }).map((n) => (n / 100).toFixed(2));
    const sizeArb = fc.integer({ min: 0, max: 1000 }).map(String);
    const opArb = fc.record({ price: priceArb, size: sizeArb, side: fc.constantFrom<"BUY" | "SELL">("BUY", "SELL") });
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 40 }), (ops) => {
        const b = new BookState("t");
        let ts = START;
        for (const op of ops) b.applyLevelUpdate(op.price, op.size, op.side, ++ts, ts);
        const bids = b.sortedBids();
        const asks = b.sortedAsks();
        const bidsDesc = bids.every((l, i) => i === 0 || l.price < bids[i - 1]!.price);
        const asksAsc = asks.every((l, i) => i === 0 || l.price > asks[i - 1]!.price);
        const bestBidOk = b.bestBid() === (bids.length > 0 ? bids[0]!.price : null);
        const bestAskOk = b.bestAsk() === (asks.length > 0 ? asks[0]!.price : null);
        return bidsDesc && asksAsc && bestBidOk && bestAskOk
          && bids.every((l) => l.size > 0n) && asks.every((l) => l.size > 0n);
      }),
      { numRuns: 300 },
    );
  });
});

describe("takerBuyImpact characterization (buy-side ask walker)", () => {
  it("walks asks best-first; exact fill across levels", () => {
    const b = freshBook();
    // 500 shares: 400 @ 0.56 + 100 @ 0.60 -> avg 0.568 exactly
    const r = b.takerBuyImpact(500_000_000n)!;
    expect(r.avgPrice6).toBe(568_000n);
    expect(r.worstPrice6).toBe(prob("0.60"));
    expect(r.impact6).toBe(8_000n);
  });

  it("QUIRK: average price truncates (floor division of cost by size)", () => {
    const b = new BookState("t");
    b.applySnapshot([], [{ price: "0.56", size: "0.000001" }, { price: "0.60", size: "100" }], START, START);
    // 3 micro-shares: 1 @ 0.56 + 2 @ 0.60 -> avg 586666.67 -> 586666 (truncated)
    const r = b.takerBuyImpact(3n)!;
    expect(r.avgPrice6).toBe(586_666n);
    expect(r.worstPrice6).toBe(prob("0.60"));
    expect(r.impact6).toBe(26_666n);
  });

  it("returns null for zero/negative size, empty asks, or insufficient depth", () => {
    const b = freshBook();
    expect(b.takerBuyImpact(0n)).toBe(null);
    expect(b.takerBuyImpact(-1n)).toBe(null);
    expect(new BookState("t").takerBuyImpact(1n)).toBe(null);
    const total = 2_000_000_000n; // 400+700+900 shares exactly
    expect(b.takerBuyImpact(total)).not.toBe(null);
    expect(b.takerBuyImpact(total + 1n)).toBe(null); // one micro-share over -> null
  });

  it("consumes the whole visible book with no price limit; worst = last touched level", () => {
    const b = freshBook();
    const r = b.takerBuyImpact(2_000_000_000n)!;
    expect(r.worstPrice6).toBe(prob("0.65"));
    // exact blended cost: (0.56*400 + 0.60*700 + 0.65*900) / 2000 = 0.6145
    expect(r.avgPrice6).toBe(614_500n);
    expect(r.impact6).toBe(54_500n);
  });

  it("property: avg is within [bestAsk, worst] and equals floor(cost/size)", () => {
    const sizeArb = fc.bigInt({ min: 1n, max: 2_000_000_000n });
    const book = freshBook();
    fc.assert(
      fc.property(sizeArb, (sz) => {
        const r = book.takerBuyImpact(sz);
        if (r === null) return sz > 2_000_000_000n;
        return r.avgPrice6 >= prob("0.56") && r.avgPrice6 <= r.worstPrice6 && r.impact6 === r.avgPrice6 - prob("0.56");
      }),
      { numRuns: 300 },
    );
  });
});

describe("quoteFlipCount characterization", () => {
  it("counts best-quote changes only after a non-null best bid was seen; QUIRK: uncounted while bid side is empty", () => {
    const b = new BookState("t");
    b.applySnapshot([{ price: "0.55", size: "5" }], [{ price: "0.56", size: "5" }], START, START);
    expect(b.quoteFlipCount).toBe(0); // first observation never counts

    b.applyLevelUpdate("0.56", "0", "SELL", START + 1, START + 1); // ask -> null
    expect(b.quoteFlipCount).toBe(1);

    b.applyLevelUpdate("0.55", "0", "BUY", START + 2, START + 2); // bid -> null
    expect(b.quoteFlipCount).toBe(2);

    // bid side empty: nothing counts, even ask changes
    b.applyLevelUpdate("0.60", "5", "SELL", START + 3, START + 3);
    b.applyLevelUpdate("0.61", "5", "SELL", START + 4, START + 4);
    expect(b.quoteFlipCount).toBe(2);

    // bid returns (still not counted: previous best bid was null)
    b.applyLevelUpdate("0.50", "5", "BUY", START + 5, START + 5);
    expect(b.quoteFlipCount).toBe(2);

    // now changes count again
    b.applyLevelUpdate("0.51", "5", "BUY", START + 6, START + 6);
    expect(b.quoteFlipCount).toBe(3);

    // deep update that leaves best quotes unchanged does not count
    b.applyLevelUpdate("0.40", "5", "BUY", START + 7, START + 7);
    expect(b.quoteFlipCount).toBe(3);
  });

  it("applyTrade records last trade without touching book timestamps or flips", () => {
    const b = freshBook();
    b.applyTrade("0.57", START + 900);
    expect(b.lastTradePrice6).toBe(prob("0.57"));
    expect(b.lastTradeTsMs).toBe(START + 900);
    expect(b.sourceTsMs).toBe(START); // unchanged
    expect(b.quoteFlipCount).toBe(0);
  });
});

describe("complementConsistency characterization", () => {
  it("uses UP best bid + DOWN best ask; 0 when they sum to exactly 1", () => {
    const up = freshBook(); // best bid 0.55
    const down = new BookState("tok-down");
    down.applySnapshot([{ price: "0.44", size: "450" }], [{ price: "0.45", size: "350" }], START, START + 30);
    expect(complementConsistency(up, down)).toBe(0); // 0.55 + 0.45 = 1
  });

  it("returns the float |1 - (upBid + downAsk)| for imbalanced books", () => {
    const up = freshBook();
    const down = new BookState("tok-down");
    down.applySnapshot([], [{ price: "0.46", size: "350" }], START, START + 30);
    expect(complementConsistency(up, down)!).toBeCloseTo(0.01, 9); // float, not exact bigint
  });

  it("null when either side of the pair is missing its quote", () => {
    const up = freshBook();
    const emptyDown = new BookState("tok-down");
    expect(complementConsistency(up, emptyDown)).toBe(null); // no DOWN ask
    const noBidUp = new BookState("tok-up2");
    noBidUp.applySnapshot([], [{ price: "0.56", size: "5" }], START, START);
    const down = new BookState("tok-down");
    down.applySnapshot([], [{ price: "0.45", size: "5" }], START, START);
    expect(complementConsistency(noBidUp, down)).toBe(null); // no UP bid
  });
});

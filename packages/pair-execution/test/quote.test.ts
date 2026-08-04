import { ONE, takerFeeUsdc, type BookLevel } from "@b5p/domain";
import { describe, expect, it } from "vitest";
import {
  quoteDirectBuy,
  quoteDirectSell,
  type DirectBuyQuoteRequest,
  type DirectSellQuoteRequest,
  type QuoteBookReference,
} from "../src/index";

const RATE = 70_000n;
const BOOK_REF: QuoteBookReference = Object.freeze({
  tokenId: "token-up",
  bookVersion: 42n,
  connectionEpoch: "connection-7",
  sourceEventId: "source-event-42",
  contentHash: "book-hash-42",
});

function buy(overrides: Partial<DirectBuyQuoteRequest> = {}): DirectBuyQuoteRequest {
  return {
    levels: [{ price: 500_000n, size: ONE }],
    requestedShares6: ONE,
    fee: { ratePpm: RATE, collection: "usdc" },
    timeInForce: "FOK",
    bookRef: BOOK_REF,
    ...overrides,
  };
}

function sell(overrides: Partial<DirectSellQuoteRequest> = {}): DirectSellQuoteRequest {
  return {
    levels: [{ price: 500_000n, size: ONE }],
    requestedShares6: ONE,
    availableShares6: ONE,
    fee: { ratePpm: RATE, collection: "usdc" },
    timeInForce: "FOK",
    bookRef: BOOK_REF,
    ...overrides,
  };
}

function acceptedBuy(req: DirectBuyQuoteRequest) {
  const result = quoteDirectBuy(req);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.detail);
  return result.quote;
}

function acceptedSell(req: DirectSellQuoteRequest) {
  const result = quoteDirectSell(req);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.detail);
  return result.quote;
}

describe("quoteDirectBuy: exact fixed-point walk", () => {
  it("rounds a one-micro-share/non-divisible principal up and accepts price one", () => {
    const dust = acceptedBuy(buy({
      levels: [{ price: 1n, size: 1n }],
      requestedShares6: 1n,
      fee: { ratePpm: 0n, collection: "usdc" },
    }));
    expect(dust.principal6).toBe(1n);
    expect(dust.averagePrice6).toBe(ONE);

    const atOne = acceptedBuy(buy({
      levels: [{ price: ONE, size: 3n }],
      requestedShares6: 3n,
      fee: { ratePpm: 0n, collection: "usdc" },
    }));
    expect(atOne.principal6).toBe(3n);
    expect(atOne.worstPrice6).toBe(ONE);
  });

  it("walks asks low-to-high and reports every exact boundary and book reference", () => {
    const quote = acceptedBuy(buy({
      levels: [
        { price: 500_000n, size: ONE },
        { price: 750_000n, size: ONE },
      ],
      requestedShares6: 1_000_001n,
      fee: { ratePpm: 0n, collection: "usdc" },
    }));

    expect(quote.levels).toEqual([
      {
        price6: 500_000n,
        grossShares6: ONE,
        cashPrincipal6: 500_000n,
        feeCash6: 0n,
        feeShares6: 0n,
        netShares6: ONE,
      },
      {
        price6: 750_000n,
        grossShares6: 1n,
        cashPrincipal6: 1n,
        feeCash6: 0n,
        feeShares6: 0n,
        netShares6: 1n,
      },
    ]);
    expect(quote.filledGrossShares6).toBe(1_000_001n);
    expect(quote.unfilledGrossShares6).toBe(0n);
    expect(quote.principal6).toBe(500_001n);
    expect(quote.averagePrice6).toBe(500_001n);
    expect(quote.topOfBookPrice6).toBe(500_000n);
    expect(quote.worstPrice6).toBe(750_000n);
    expect(quote.impactFromTop6).toBe(250_000n);
    expect(quote.fullyExecutable).toBe(true);
    expect(quote.bookRef).toBe(BOOK_REF);
  });

  it("sums nonlinear fees per distinct consumed price level", () => {
    const quote = acceptedBuy(buy({
      levels: [
        { price: 500_000n, size: ONE },
        { price: 750_000n, size: ONE },
      ],
      requestedShares6: 2n * ONE,
    }));
    expect(quote.levels.map((level) => level.feeCash6)).toEqual([17_500n, 13_125n]);
    expect(quote.feeCash6).toBe(30_625n);
    expect(quote.feeCash6).toBe(
      takerFeeUsdc(ONE, 500_000n, RATE) + takerFeeUsdc(ONE, 750_000n, RATE),
    );
  });

  it("canonically aggregates duplicate prices before rounding principal and fee", () => {
    const quote = acceptedBuy(buy({
      levels: [
        { price: 500_000n, size: 1n },
        { price: 500_000n, size: 1n },
      ],
      requestedShares6: 2n,
    }));
    expect(quote.levels).toHaveLength(1);
    expect(quote.levels[0]).toMatchObject({
      grossShares6: 2n,
      cashPrincipal6: 1n,
      feeCash6: 1n,
    });
  });

  it("treats the limit as inclusive and does not consume one micro-price beyond it", () => {
    const levels: readonly BookLevel[] = [
      { price: 500_000n, size: ONE },
      { price: 500_001n, size: ONE },
    ];
    expect(acceptedBuy(buy({ levels, requestedShares6: 2n * ONE, limitPrice6: 500_001n })).fullyExecutable).toBe(true);

    const partial = acceptedBuy(buy({
      levels,
      requestedShares6: 2n * ONE,
      limitPrice6: 500_000n,
      timeInForce: "FAK",
    }));
    expect(partial.filledGrossShares6).toBe(ONE);
    expect(partial.unfilledGrossShares6).toBe(ONE);
    expect(partial.worstPrice6).toBe(500_000n);
    expect(partial.fullyExecutable).toBe(false);
  });

  it("makes FOK all-or-nothing for depth, limit, and a cap short by one micro-USDC", () => {
    const depthShort = acceptedBuy(buy({
      levels: [{ price: 500_000n, size: ONE - 1n }],
    }));
    expect(depthShort.levels).toEqual([]);
    expect(depthShort.principal6).toBe(0n);
    expect(depthShort.feeCash6).toBe(0n);
    expect(depthShort.unfilledGrossShares6).toBe(ONE);

    const limitShort = acceptedBuy(buy({ limitPrice6: 499_999n }));
    expect(limitShort.filledGrossShares6).toBe(0n);

    const exactDebit = 500_000n + 17_500n;
    expect(acceptedBuy(buy({ cashCap6: exactDebit })).fullyExecutable).toBe(true);
    const capShort = acceptedBuy(buy({ cashCap6: exactDebit - 1n }));
    expect(capShort.filledGrossShares6).toBe(0n);
    expect(capShort.principal6).toBe(0n);
  });

  it("allows FAK to consume the largest exact cap-affordable prefix", () => {
    const quote = acceptedBuy(buy({
      requestedShares6: 2n * ONE,
      levels: [{ price: 500_000n, size: 2n * ONE }],
      cashCap6: 500_000n + 17_500n,
      timeInForce: "FAK",
    }));
    expect(quote.filledGrossShares6).toBe(ONE);
    expect(quote.unfilledGrossShares6).toBe(ONE);
    expect(quote.principal6 + quote.feeCash6).toBe(517_500n);
  });

  it("models share-collected fees as net token balance, not cash", () => {
    const quote = acceptedBuy(buy({ fee: { ratePpm: RATE, collection: "shares" } }));
    expect(quote.principal6).toBe(500_000n);
    expect(quote.feeCash6).toBe(0n);
    expect(quote.feeShares6).toBe(35_000n);
    expect(quote.receivedNetShares6).toBe(965_000n);
  });

  it("is exact for bigint magnitudes far above the safe integer range", () => {
    const huge = 10n ** 30n;
    const quote = acceptedBuy(buy({
      levels: [{ price: 500_000n, size: huge }],
      requestedShares6: huge,
      fee: { ratePpm: 0n, collection: "usdc" },
    }));
    expect(quote.principal6).toBe(5n * 10n ** 29n);
    expect(quote.filledGrossShares6).toBe(huge);
  });
});

describe("quoteDirectSell: bid-side unwind economics", () => {
  it("walks only bids high-to-low, floors proceeds, and subtracts cash fees", () => {
    const quote = acceptedSell(sell({
      levels: [
        { price: 750_000n, size: ONE },
        { price: 500_000n, size: ONE },
      ],
      requestedShares6: 1_000_001n,
      availableShares6: 1_000_001n,
    }));
    expect(quote.levels[0]).toMatchObject({
      price6: 750_000n,
      grossShares6: ONE,
      cashPrincipal6: 750_000n,
      feeCash6: 13_125n,
    });
    expect(quote.levels[1]).toMatchObject({
      price6: 500_000n,
      grossShares6: 1n,
      cashPrincipal6: 0n,
      feeCash6: 1n,
    });
    expect(quote.principal6 - quote.feeCash6).toBe(736_874n);
    expect(quote.topOfBookPrice6).toBe(750_000n);
    expect(quote.worstPrice6).toBe(500_000n);
    expect(quote.averagePrice6).toBe(749_999n);
  });

  it("leaves the exact residual for a partial FAK", () => {
    const quote = acceptedSell(sell({
      levels: [{ price: 600_000n, size: ONE }],
      requestedShares6: ONE + 1n,
      availableShares6: ONE + 1n,
      timeInForce: "FAK",
    }));
    expect(quote.filledGrossShares6).toBe(ONE);
    expect(quote.unfilledGrossShares6).toBe(1n);
    expect(quote.fullyExecutable).toBe(false);
  });

  it("uses an inclusive sell limit and FOK never exposes a partial fill", () => {
    const atLimit = acceptedSell(sell({ limitPrice6: 500_000n }));
    expect(atLimit.fullyExecutable).toBe(true);

    const breached = acceptedSell(sell({ limitPrice6: 500_001n }));
    expect(breached.filledGrossShares6).toBe(0n);
    expect(breached.principal6).toBe(0n);
    expect(breached.feeCash6).toBe(0n);
  });

  it("rejects a sell without sufficient proven inventory", () => {
    expect(quoteDirectSell(sell({ availableShares6: ONE - 1n }))).toMatchObject({
      ok: false,
      reason: "INSUFFICIENT_INVENTORY",
    });
    expect(quoteDirectSell(sell({ availableShares6: -1n }))).toMatchObject({
      ok: false,
      reason: "INVALID_REQUEST",
    });
  });

  it("fails closed for share-collected sell semantics", () => {
    expect(quoteDirectSell(sell({ fee: { ratePpm: RATE, collection: "shares" } }))).toMatchObject({
      ok: false,
      reason: "UNSUPPORTED_SELL_FEE_COLLECTION",
    });
  });
});

describe("direct matcher validation and purity", () => {
  it.each([
    { levels: [{ price: 0n, size: ONE }], label: "zero price" },
    { levels: [{ price: ONE + 1n, size: ONE }], label: "price above one" },
    { levels: [{ price: 500_000n, size: 0n }], label: "zero size" },
    { levels: [{ price: 500_000n, size: -1n }], label: "negative size" },
    {
      levels: [
        { price: 600_000n, size: ONE },
        { price: 500_000n, size: ONE },
      ],
      label: "unsorted asks",
    },
  ])("rejects malformed BUY books: $label", ({ levels }) => {
    expect(quoteDirectBuy(buy({ levels }))).toMatchObject({ ok: false, reason: "MALFORMED_BOOK" });
  });

  it("rejects unsorted bids", () => {
    expect(quoteDirectSell(sell({
      levels: [
        { price: 500_000n, size: ONE },
        { price: 600_000n, size: ONE },
      ],
    }))).toMatchObject({ ok: false, reason: "MALFORMED_BOOK" });
  });

  it("rejects zero/negative requests, bad limits, bad caps, bad rates, and bad TIF", () => {
    expect(quoteDirectBuy(buy({ requestedShares6: 0n }))).toMatchObject({ ok: false, reason: "INVALID_REQUEST" });
    expect(quoteDirectBuy(buy({ requestedShares6: -1n }))).toMatchObject({ ok: false, reason: "INVALID_REQUEST" });
    expect(quoteDirectBuy(buy({ limitPrice6: 0n }))).toMatchObject({ ok: false, reason: "INVALID_REQUEST" });
    expect(quoteDirectBuy(buy({ cashCap6: -1n }))).toMatchObject({ ok: false, reason: "INVALID_REQUEST" });
    expect(quoteDirectBuy(buy({ fee: { ratePpm: -1n, collection: "usdc" } }))).toMatchObject({ ok: false, reason: "INVALID_REQUEST" });
    expect(quoteDirectBuy(buy({ fee: { ratePpm: 1_000_001n, collection: "usdc" } }))).toMatchObject({ ok: false, reason: "INVALID_REQUEST" });
    expect(quoteDirectBuy(buy({ timeInForce: "GTC" as "FOK" }))).toMatchObject({ ok: false, reason: "INVALID_REQUEST" });
  });

  it("fails closed rather than throwing when fee evidence is missing or unknown", () => {
    expect(quoteDirectBuy(buy({ fee: undefined as never }))).toMatchObject({
      ok: false,
      reason: "FEE_SNAPSHOT_MISSING",
    });
    expect(quoteDirectBuy(buy({ fee: { ratePpm: RATE, collection: "mystery" } }))).toMatchObject({
      ok: false,
      reason: "FEE_CONVENTION_UNKNOWN",
    });
  });

  it("returns an exact empty-book result and never mutates caller input", () => {
    const levels = Object.freeze([
      Object.freeze({ price: 500_000n, size: ONE }),
      Object.freeze({ price: 750_000n, size: ONE }),
    ]);
    const req = Object.freeze(buy({ levels, requestedShares6: 2n * ONE }));
    expect(() => quoteDirectBuy(req)).not.toThrow();
    expect(levels).toEqual([
      { price: 500_000n, size: ONE },
      { price: 750_000n, size: ONE },
    ]);

    const empty = acceptedBuy(buy({ levels: [], timeInForce: "FAK" }));
    expect(empty.levels).toEqual([]);
    expect(empty.topOfBookPrice6).toBeNull();
    expect(empty.worstPrice6).toBeNull();
    expect(empty.averagePrice6).toBeNull();
    expect(empty.impactFromTop6).toBeNull();
    expect(empty.unfilledGrossShares6).toBe(ONE);
  });
});

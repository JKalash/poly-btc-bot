import { describe, expect, it } from "vitest";
import {
  breakEvenMaker, breakEvenTakerShareCollected, breakEvenTakerUsdcCollected,
  fmtProb, fmtUsdc, lossErasesWins, makerEdgeSatisfied, makerEvPerCost,
  netWinningSharesShareCollected, ONE, PPM, ppm, prob, shares, takerEdgeSatisfied,
  takerEvPerCost, takerFeeShares, takerFeeUsdc, toNumber, usdc,
} from "../src/index";

const RATE = ppm("0.07"); // verified live: crypto_fees_v2 rate 0.07, takerOnly

describe("taker fee (USDC-collected) at spec prices", () => {
  // fee = shares * 0.07 * p * (1-p) for 100 shares
  const cases: Array<[string, string]> = [
    ["0.50", "1.75"],
    ["0.75", "1.3125"],
    ["0.80", "1.12"],
    ["0.85", "0.8925"],
    ["0.90", "0.63"],
    ["0.95", "0.3325"],
  ];
  for (const [p, expected] of cases) {
    it(`100 shares at ${p} -> ${expected} USDC`, () => {
      expect(fmtUsdc(takerFeeUsdc(shares("100"), prob(p), RATE))).toBe(expected);
    });
  }

  it("matches the docs example: max fee for 100 shares in crypto is $1.75 at p=0.5", () => {
    expect(fmtUsdc(takerFeeUsdc(shares("100"), prob("0.5"), RATE))).toBe("1.75");
  });

  it("the seeded 95-cent case: 839 shares at 0.95 -> fee ~2.79, cost 797.05", () => {
    const fee = takerFeeUsdc(shares("839"), prob("0.95"), RATE);
    expect(toNumber(fee)).toBeCloseTo(2.789675, 6);
    // cost = 839 * 0.95
    expect(839 * 0.95).toBeCloseTo(797.05, 2);
  });
});

describe("effective break-even", () => {
  it("maker break-even equals price", () => {
    expect(breakEvenMaker(prob("0.95"))).toBe(prob("0.95"));
  });

  it("taker at 0.95 is ~95.33% under both collection conventions", () => {
    const beUsdc = breakEvenTakerUsdcCollected(prob("0.95"), RATE);
    const beShares = breakEvenTakerShareCollected(prob("0.95"), RATE);
    expect(toNumber(beUsdc)).toBeCloseTo(0.953325, 5);
    expect(toNumber(beShares)).toBeCloseTo(0.953336, 5);
    // both round to the spec's "approximately 95.33%"
    expect(fmtProb(beUsdc).startsWith("0.9533")).toBe(true);
    expect(fmtProb(beShares).startsWith("0.9533")).toBe(true);
  });

  it("taker break-even always exceeds price for p in (0,1)", () => {
    for (const p of ["0.05", "0.25", "0.50", "0.75", "0.95", "0.99"]) {
      expect(breakEvenTakerUsdcCollected(prob(p), RATE) > prob(p)).toBe(true);
      expect(breakEvenTakerShareCollected(prob(p), RATE) > prob(p)).toBe(true);
    }
  });

  it("share-collected break-even is the exact rational ceiling — never a micro-unit low", () => {
    // q* = p / (1 - f*(1-p)); be must be the minimal integer with be*denom >= p*PPM*ONE
    for (let pMicro = 997; pMicro < 1_000_000; pMicro += 997) {
      const p = BigInt(pMicro);
      const denom = PPM * ONE - RATE * (ONE - p);
      const be = breakEvenTakerShareCollected(p, RATE);
      expect(be * denom >= p * PPM * ONE).toBe(true);
      expect((be - 1n) * denom < p * PPM * ONE).toBe(true);
    }
  });
});

describe("share-collected fee variant", () => {
  it("fee shares = C * f * (1-p); net winning shares reduced accordingly", () => {
    const fee = takerFeeShares(shares("839"), prob("0.95"), RATE);
    expect(toNumber(fee)).toBeCloseTo(839 * 0.07 * 0.05, 6); // 2.9365 shares
    const net = netWinningSharesShareCollected(shares("839"), prob("0.95"), RATE);
    expect(toNumber(net)).toBeCloseTo(839 - 2.9365, 4);
  });
});

describe("EV and edge gates", () => {
  it("maker EV per cost = q/p - 1", () => {
    expect(makerEvPerCost(prob("0.60"), prob("0.50"))).toBeCloseTo(0.2, 6);
  });

  it("maker gate: q must exceed p*(1+minEdge) exactly", () => {
    const minEdge = ppm("0.02");
    expect(makerEdgeSatisfied(prob("0.51"), prob("0.50"), minEdge)).toBe(true);  // 2% edge exactly
    expect(makerEdgeSatisfied(prob("0.509999"), prob("0.50"), minEdge)).toBe(false);
  });

  it("taker gate at 0.95 requires q above ~95.33% plus edge", () => {
    const sched = { ratePpm: RATE, collection: "usdc" as const };
    expect(takerEdgeSatisfied(prob("0.96"), prob("0.95"), sched, 0n)).toBe(true);
    expect(takerEdgeSatisfied(prob("0.953"), prob("0.95"), sched, 0n)).toBe(false);
    expect(takerEvPerCost(prob("0.953325"), prob("0.95"), sched)).toBeCloseTo(0, 4);
  });

  it("a loss at 0.95 erases ~19 wins", () => {
    expect(lossErasesWins(prob("0.95"))).toBeCloseTo(19, 6);
  });
});

describe("fixed-point primitives", () => {
  it("parse/format round trip", () => {
    expect(fmtUsdc(usdc("797.05"))).toBe("797.05");
    expect(fmtProb(prob("0.9533"))).toBe("0.9533");
  });
  it("rejects excess precision", () => {
    expect(() => usdc("1.1234567")).toThrow();
  });
});

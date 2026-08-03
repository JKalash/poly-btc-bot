/**
 * BPAIR-002 characterization tests for packages/domain/src/fees.ts.
 *
 * Pins the CURRENT exact micro-unit outputs of both fee-collection
 * conventions (USDC-collected and share-collected) and both taker break-even
 * formulas, including boundary prices and the ceil rounding direction. All
 * expected constants below were computed from the current implementation and
 * verified against the closed-form fee = shares * rate * p * (1-p).
 *
 * Quirks pinned (current behavior, not endorsements):
 *  - takerFeeUsdc ceil-rounds, so a 1-micro-share trade at mid prices pays a
 *    full micro-USDC of fee (massive relative overcharge on dust sizes).
 *  - takerFeeShares at p=0 charges the full rate * shares in fee shares
 *    (sh * f * (1-p) with p=0), even though such a fill would cost nothing.
 *  - netWinningSharesShareCollected of a 1-micro-share win is 0 at any
 *    p in (0,1) because the ceil'd fee is at least 1 micro-share.
 *  - breakEvenTakerUsdcCollected(1 micro) = 2 micro — double the price.
 *  - share-collected break-even >= usdc-collected break-even at every price.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  breakEvenTaker, breakEvenTakerShareCollected, breakEvenTakerUsdcCollected,
  mulDiv, netWinningSharesShareCollected, ONE, ppm, PPM, prob, shares,
  takerFeeShares, takerFeeUsdc,
} from "../src/index";

const RATE = ppm("0.07"); // crypto_fees_v2, verified live 2026-07-31
const S100 = shares("100");

describe("takerFeeUsdc — exact micro-USDC vectors for 100 shares at 7%", () => {
  const vectors: Array<[bigint, bigint]> = [
    [0n, 0n], // p=0: fee is exactly zero
    [1n, 7n], // p=1 micro: ceil of a near-zero product -> 7 micro-USDC
    [10_000n, 69_300n], // p=0.01 -> 0.0693 USDC (exact)
    [123_457n, 757_508n], // non-exact division, ceil'd
    [333_333n, 1_555_555n],
    [500_000n, 1_750_000n], // docs max: $1.75 (exact)
    [950_000n, 332_500n], // the seeded 95c case for 100 sh (exact)
    [999_999n, 7n], // mirror of p=1 micro
    [ONE, 0n], // p=1: fee is exactly zero
  ];
  for (const [p, fee] of vectors) {
    it(`p=${p} -> ${fee} micro-USDC`, () => {
      expect(takerFeeUsdc(S100, p, RATE)).toBe(fee);
    });
  }

  it("839 shares at 0.95 -> exactly 2.789675 USDC", () => {
    expect(takerFeeUsdc(shares("839"), prob("0.95"), RATE)).toBe(2_789_675n);
  });

  it("odd size and price: 333.333333 shares at 0.333333 -> 5185183 (ceil'd)", () => {
    expect(takerFeeUsdc(333_333_333n, 333_333n, RATE)).toBe(5_185_183n);
  });

  it("dust quirk: 1 micro-share pays a whole micro-USDC at mid prices (ceil)", () => {
    expect(takerFeeUsdc(1n, prob("0.5"), RATE)).toBe(1n);
    expect(takerFeeUsdc(1n, prob("0.95"), RATE)).toBe(1n);
  });

  it("large sizes stay exact: 1e12 shares at 0.5 -> 17.5e15 micro-USDC", () => {
    expect(takerFeeUsdc(10n ** 18n, prob("0.5"), RATE)).toBe(17_500_000_000_000_000n);
  });

  it("property: fee is exactly ceil(sh*rate*p*(1-p) / 1e18) and symmetric in p vs 1-p", () => {
    const pArb = fc.bigInt({ min: 0n, max: ONE });
    const shArb = fc.bigInt({ min: 0n, max: 10n ** 12n });
    fc.assert(
      fc.property(pArb, shArb, (p, sh) => {
        const product = sh * RATE * p * (ONE - p);
        const ceilRef = product === 0n ? 0n : (product + 10n ** 18n - 1n) / 10n ** 18n;
        return takerFeeUsdc(sh, p, RATE) === ceilRef
          && takerFeeUsdc(sh, p, RATE) === takerFeeUsdc(sh, ONE - p, RATE);
      }),
      { numRuns: 1000 },
    );
  });

  it("nonlinear shape: fee rises from 0 to the p=0.5 maximum then falls", () => {
    const fees = [0n, 100_000n, 250_000n, 400_000n, 500_000n].map((p) => takerFeeUsdc(S100, p, RATE));
    for (let i = 1; i < fees.length; i++) expect(fees[i]! > fees[i - 1]!).toBe(true);
    expect(takerFeeUsdc(S100, 600_000n, RATE) < takerFeeUsdc(S100, 500_000n, RATE)).toBe(true);
  });
});

describe("takerFeeShares — share-collected convention", () => {
  it("fee shares = sh * rate * (1-p), independent of the p in the denominator (it cancels)", () => {
    // exact vectors for 100 shares
    expect(takerFeeShares(S100, 0n, RATE)).toBe(7_000_000n); // p=0 -> full 7% of shares (quirk)
    expect(takerFeeShares(S100, 1n, RATE)).toBe(6_999_993n);
    expect(takerFeeShares(S100, prob("0.5"), RATE)).toBe(3_500_000n);
    expect(takerFeeShares(S100, prob("0.95"), RATE)).toBe(350_000n);
    expect(takerFeeShares(S100, 999_999n, RATE)).toBe(7n);
    expect(takerFeeShares(S100, ONE, RATE)).toBe(0n); // p=1 -> zero
  });

  it("839 shares at 0.95 -> exactly 2.9365 fee shares; net 836.0635", () => {
    expect(takerFeeShares(shares("839"), prob("0.95"), RATE)).toBe(2_936_500n);
    expect(netWinningSharesShareCollected(shares("839"), prob("0.95"), RATE)).toBe(836_063_500n);
  });

  it("dust quirk: a 1-micro-share win at p in (0,1) nets ZERO shares (ceil'd fee eats it)", () => {
    expect(takerFeeShares(1n, prob("0.95"), RATE)).toBe(1n);
    expect(netWinningSharesShareCollected(1n, prob("0.95"), RATE)).toBe(0n);
    expect(netWinningSharesShareCollected(1n, ONE, RATE)).toBe(1n); // only p=1 keeps the dust
  });

  it("property: fee = ceil(sh*rate*(1-p)/1e12); net never negative, never exceeds sh", () => {
    const pArb = fc.bigInt({ min: 0n, max: ONE });
    const shArb = fc.bigInt({ min: 0n, max: 10n ** 12n });
    fc.assert(
      fc.property(pArb, shArb, (p, sh) => {
        const product = sh * RATE * (ONE - p);
        const ceilRef = product === 0n ? 0n : (product + 10n ** 12n - 1n) / 10n ** 12n;
        const net = netWinningSharesShareCollected(sh, p, RATE);
        return takerFeeShares(sh, p, RATE) === ceilRef && net >= 0n && net <= sh;
      }),
      { numRuns: 1000 },
    );
  });
});

describe("break-even characterization", () => {
  it("USDC-collected: q* = p + ceil(f*p*(1-p)) — exact vectors", () => {
    expect(breakEvenTakerUsdcCollected(0n, RATE)).toBe(0n);
    expect(breakEvenTakerUsdcCollected(1n, RATE)).toBe(2n); // quirk: double the price at p=1 micro
    expect(breakEvenTakerUsdcCollected(333_333n, RATE)).toBe(348_889n);
    expect(breakEvenTakerUsdcCollected(prob("0.5"), RATE)).toBe(517_500n);
    expect(breakEvenTakerUsdcCollected(prob("0.95"), RATE)).toBe(953_325n);
    expect(breakEvenTakerUsdcCollected(999_999n, RATE)).toBe(ONE); // rounds up to exactly 1.0
    expect(breakEvenTakerUsdcCollected(ONE, RATE)).toBe(ONE);
  });

  it("share-collected: q* = ceil(p / (1 - f*(1-p))) — exact vectors", () => {
    expect(breakEvenTakerShareCollected(0n, RATE)).toBe(0n);
    expect(breakEvenTakerShareCollected(1n, RATE)).toBe(2n);
    expect(breakEvenTakerShareCollected(333_333n, RATE)).toBe(349_651n);
    expect(breakEvenTakerShareCollected(prob("0.5"), RATE)).toBe(518_135n);
    expect(breakEvenTakerShareCollected(prob("0.95"), RATE)).toBe(953_337n);
    expect(breakEvenTakerShareCollected(999_999n, RATE)).toBe(ONE);
    expect(breakEvenTakerShareCollected(ONE, RATE)).toBe(ONE);
  });

  it("degenerate schedule (denominator <= 0) throws for share-collected only", () => {
    // rate 100% at p=0: denom = PPM*ONE - PPM*ONE = 0
    expect(() => breakEvenTakerShareCollected(0n, PPM)).toThrow("degenerate fee schedule");
    expect(() => breakEvenTakerShareCollected(0n, PPM + 1n)).toThrow("degenerate fee schedule");
    // the USDC-collected formula happily accepts the same schedule
    expect(breakEvenTakerUsdcCollected(0n, PPM)).toBe(0n);
  });

  it("breakEvenTaker dispatches on the collection convention", () => {
    const p = prob("0.95");
    expect(breakEvenTaker(p, { ratePpm: RATE, collection: "usdc" })).toBe(953_325n);
    expect(breakEvenTaker(p, { ratePpm: RATE, collection: "shares" })).toBe(953_337n);
  });

  it("property: share-collected >= usdc-collected >= p, both <= ONE at 7%", () => {
    const pArb = fc.bigInt({ min: 0n, max: ONE });
    fc.assert(
      fc.property(pArb, (p) => {
        const u = breakEvenTakerUsdcCollected(p, RATE);
        const s = breakEvenTakerShareCollected(p, RATE);
        return s >= u && u >= p && s <= ONE;
      }),
      { numRuns: 1000 },
    );
  });

  it("share-collected break-even is the minimal integer ceiling of the exact rational", () => {
    for (const p of [1n, 333_333n, 500_000n, 950_000n, 999_999n]) {
      const denom = PPM * ONE - RATE * (ONE - p);
      const be = breakEvenTakerShareCollected(p, RATE);
      expect(be * denom >= p * PPM * ONE).toBe(true);
      expect((be - 1n) * denom < p * PPM * ONE).toBe(true);
      // and it equals a single exact mulDiv ceil, no intermediate flooring
      expect(be).toBe(mulDiv(p * PPM, ONE, denom, "ceil"));
    }
  });
});

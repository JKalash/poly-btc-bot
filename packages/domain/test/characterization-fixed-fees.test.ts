/**
 * BPAIR-002 characterization tests — packages/domain fixed math + fee math.
 *
 * These tests PIN current behavior (spec §25.2 Phase 0). They are expected to
 * fail if anyone changes rounding semantics, fee formulas, or boundary
 * behavior that the pair subsystem will depend on. Where behavior is subtle
 * it is pinned with a comment, NOT fixed.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  ONE, PPM, breakEvenMaker, breakEvenTaker, breakEvenTakerShareCollected,
  breakEvenTakerUsdcCollected, mulDiv, netWinningSharesShareCollected, ppm,
  prob, shares, takerFeeShares, takerFeeUsdc,
} from "../src/index";

const RATE = ppm("0.07"); // 70_000n — live-verified crypto_fees_v2 taker rate

describe("mulDiv characterization: positive values", () => {
  it("default mode is floor (truncation for positive results)", () => {
    expect(mulDiv(7n, 1n, 2n)).toBe(3n);
    expect(mulDiv(7n, 1n, 2n, "floor")).toBe(3n);
  });

  it("exact division is mode-independent", () => {
    for (const mode of ["floor", "ceil", "half-even"] as const) {
      expect(mulDiv(10n, 3n, 5n, mode)).toBe(6n);
      expect(mulDiv(0n, 123n, 7n, mode)).toBe(0n);
    }
  });

  it("ceil rounds a positive remainder up; one micro-unit never rounds to zero", () => {
    expect(mulDiv(7n, 1n, 2n, "ceil")).toBe(4n);
    expect(mulDiv(1n, 1n, ONE, "ceil")).toBe(1n); // 1e-6 -> 1 (conservative for fee payer)
    expect(mulDiv(1n, 1n, ONE, "floor")).toBe(0n);
    expect(mulDiv(1n, 1n, ONE, "half-even")).toBe(0n); // far below half
  });

  it("half-even: ties go to the even quotient, non-ties to nearest", () => {
    expect(mulDiv(1n, 1n, 2n, "half-even")).toBe(0n); // 0.5 -> 0 (even)
    expect(mulDiv(3n, 1n, 2n, "half-even")).toBe(2n); // 1.5 -> 2 (even)
    expect(mulDiv(5n, 1n, 2n, "half-even")).toBe(2n); // 2.5 -> 2 (even)
    expect(mulDiv(7n, 1n, 2n, "half-even")).toBe(4n); // 3.5 -> 4 (even)
    expect(mulDiv(5n, 1n, 4n, "half-even")).toBe(1n); // 1.25 -> 1 (below half)
    expect(mulDiv(7n, 1n, 4n, "half-even")).toBe(2n); // 1.75 -> 2 (above half)
  });

  it("throws on division by zero in every mode", () => {
    for (const mode of ["floor", "ceil", "half-even"] as const) {
      expect(() => mulDiv(1n, 1n, 0n, mode)).toThrow("division by zero");
    }
  });
});

describe("mulDiv characterization: NEGATIVE values (subtle — pinned, not fixed)", () => {
  // The implementation computes the quotient on MAGNITUDES and then applies
  // the sign. The branch `if (mode === "floor" && neg) q += 1n` means that for
  // a negative result "floor" INCREASES the magnitude — i.e. floor rounds
  // toward negative infinity (mathematical floor, AWAY from zero for
  // negatives), and "ceil" on a negative result keeps the truncated magnitude
  // — i.e. ceil rounds toward zero for negatives (mathematical ceiling).
  // NOTE: the inline comment in fixed.ts line 35 ("magnitude rounds toward
  // zero handled below by sign flip") describes the CEIL case, not the floor
  // branch it annotates. The behavior pinned here is the actual behavior.
  it("floor on a negative result rounds away from zero (toward -inf): -7/2 -> -4", () => {
    expect(mulDiv(-7n, 1n, 2n, "floor")).toBe(-4n);
    expect(mulDiv(7n, -1n, 2n, "floor")).toBe(-4n);
    expect(mulDiv(7n, 1n, -2n, "floor")).toBe(-4n);
    expect(mulDiv(-7n, 1n, 2n)).toBe(-4n); // default mode is floor
  });

  it("ceil on a negative result truncates toward zero: -7/2 -> -3", () => {
    expect(mulDiv(-7n, 1n, 2n, "ceil")).toBe(-3n);
    expect(mulDiv(7n, -1n, 2n, "ceil")).toBe(-3n);
    expect(mulDiv(7n, 1n, -2n, "ceil")).toBe(-3n);
  });

  it("sign is the XOR of the three operand signs", () => {
    expect(mulDiv(-7n, -1n, 2n, "ceil")).toBe(4n);   // two negatives cancel
    expect(mulDiv(-7n, 1n, -2n, "ceil")).toBe(4n);
    expect(mulDiv(-7n, -1n, -2n, "floor")).toBe(-4n); // three negatives -> negative
    expect(mulDiv(-7n, -1n, -2n, "ceil")).toBe(-3n);
  });

  it("half-even on negatives: nearest, ties to the even (sign-symmetric) quotient", () => {
    expect(mulDiv(-5n, 1n, 2n, "half-even")).toBe(-2n); // -2.5 -> -2 (even)
    expect(mulDiv(-7n, 1n, 2n, "half-even")).toBe(-4n); // -3.5 -> -4 (even)
    expect(mulDiv(-5n, 1n, 4n, "half-even")).toBe(-1n); // -1.25 -> -1
    expect(mulDiv(-7n, 1n, 4n, "half-even")).toBe(-2n); // -1.75 -> -2
  });

  it("exact negative division has no rounding adjustment", () => {
    for (const mode of ["floor", "ceil", "half-even"] as const) {
      expect(mulDiv(-4n, 1n, 2n, mode)).toBe(-2n);
    }
  });
});

describe("mulDiv characterization: boundary magnitudes", () => {
  it("values above Number.MAX_SAFE_INTEGER stay exact (no float path)", () => {
    const p53 = 2n ** 53n;
    expect(mulDiv(p53 + 1n, 1n, 1n)).toBe(p53 + 1n);
    expect(mulDiv(p53, p53, 1n)).toBe(2n ** 106n);
    expect(mulDiv(2n ** 106n + 1n, 1n, 2n, "ceil")).toBe(2n ** 105n + 1n);
    expect(mulDiv(2n ** 106n + 1n, 1n, 2n, "floor")).toBe(2n ** 105n);
  });

  it("very large intermediate products divide exactly", () => {
    expect(mulDiv(10n ** 30n, 10n ** 30n, 10n ** 30n)).toBe(10n ** 30n);
    expect(mulDiv(10n ** 30n + 1n, 10n ** 18n, 10n ** 18n)).toBe(10n ** 30n + 1n);
  });

  it("property: for d>0, floor/ceil bracket the exact rational for ANY signs of a,b", () => {
    fc.assert(
      fc.property(
        fc.bigInt(-(10n ** 18n), 10n ** 18n),
        fc.bigInt(-(10n ** 12n), 10n ** 12n),
        fc.bigInt(1n, 10n ** 12n),
        (a, b, d) => {
          const n = a * b;
          const f = mulDiv(a, b, d, "floor");
          const c = mulDiv(a, b, d, "ceil");
          expect(f * d <= n).toBe(true);
          expect(n < (f + 1n) * d).toBe(true);
          expect(c * d >= n).toBe(true);
          expect((c - 1n) * d < n).toBe(true);
          expect(c - f === 0n || c - f === 1n).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("property: half-even is within half a unit; exact ties land on an even quotient", () => {
    fc.assert(
      fc.property(
        fc.bigInt(-(10n ** 18n), 10n ** 18n),
        fc.bigInt(-(10n ** 12n), 10n ** 12n),
        fc.bigInt(1n, 10n ** 12n),
        (a, b, d) => {
          const q = mulDiv(a, b, d, "half-even");
          const diff = a * b - q * d;
          const twice = 2n * (diff < 0n ? -diff : diff);
          expect(twice <= d).toBe(true);
          if (twice === d) expect(q % 2n).toBe(0n);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("takerFeeUsdc characterization (rate 70000 ppm, ceil-rounded)", () => {
  it("exact vectors at typical prices", () => {
    // fee = sh * 0.07 * p * (1-p), exact in micro-USDC when the product divides
    expect(takerFeeUsdc(shares("1"), prob("0.5"), RATE)).toBe(17_500n);     // $0.0175
    expect(takerFeeUsdc(shares("100"), prob("0.95"), RATE)).toBe(332_500n); // $0.3325
    expect(takerFeeUsdc(shares("1"), prob("0.99"), RATE)).toBe(693n);       // $0.000693
  });

  it("fee is zero only at the exact price boundaries p=0 and p=1", () => {
    expect(takerFeeUsdc(shares("1000"), 0n, RATE)).toBe(0n);
    expect(takerFeeUsdc(shares("1000"), ONE, RATE)).toBe(0n);
    expect(takerFeeUsdc(0n, prob("0.5"), RATE)).toBe(0n);
  });

  it("ceil-rounding pins a nonzero fee for arbitrarily tiny fee products", () => {
    // 1 share at p=0.999999: exact fee is 0.069999... micro-USDC -> ceil to 1.
    expect(takerFeeUsdc(shares("1"), prob("0.999999"), RATE)).toBe(1n);
  });

  it("fractional shares round the fee UP (conservative for the payer)", () => {
    // 0.333333 sh at 0.5: exact quotient 5833.3275 micro-USDC -> 5834
    expect(takerFeeUsdc(333_333n, prob("0.5"), RATE)).toBe(5_834n);
  });
});

describe("takerFeeShares / net winning shares characterization (share-collected)", () => {
  it("exact vectors: fee shares = sh * rate * (1-p), ceil-rounded", () => {
    expect(takerFeeShares(shares("1"), prob("0.5"), RATE)).toBe(35_000n);  // 0.035 sh
    expect(takerFeeShares(shares("1"), prob("0.95"), RATE)).toBe(3_500n);  // 0.0035 sh
    expect(takerFeeShares(shares("1"), ONE, RATE)).toBe(0n);
  });

  it("ceil-rounding can consume 100% of a dust trade", () => {
    // 1 micro-share at p=0.5: exact fee 0.035 micro-shares -> ceil to 1, so
    // netWinningShares of a 1-micro-share buy is ZERO. Pinned: dust buys can
    // be entirely eaten by rounding under the share-collected convention.
    expect(takerFeeShares(1n, prob("0.5"), RATE)).toBe(1n);
    expect(netWinningSharesShareCollected(1n, prob("0.5"), RATE)).toBe(0n);
  });

  it("net winning shares = gross - fee shares", () => {
    expect(netWinningSharesShareCollected(shares("1"), prob("0.5"), RATE)).toBe(965_000n);
  });
});

describe("break-even characterization at boundary and typical prices", () => {
  it("maker break-even is the identity", () => {
    expect(breakEvenMaker(prob("0.95"))).toBe(950_000n);
    expect(breakEvenMaker(0n)).toBe(0n);
    expect(breakEvenMaker(ONE)).toBe(ONE);
  });

  it("USDC-collected: q* = p + ceil(f*p*(1-p)) — exact vectors", () => {
    expect(breakEvenTakerUsdcCollected(prob("0.5"), RATE)).toBe(517_500n);
    expect(breakEvenTakerUsdcCollected(prob("0.95"), RATE)).toBe(953_325n);
    expect(breakEvenTakerUsdcCollected(prob("0.01"), RATE)).toBe(10_693n);
    expect(breakEvenTakerUsdcCollected(0n, RATE)).toBe(0n);
    expect(breakEvenTakerUsdcCollected(ONE, RATE)).toBe(ONE);
  });

  it("USDC-collected at p=0.999999: ceil pushes break-even to exactly 1.0 (certainty)", () => {
    // The exact fee increment is 0.069999... micro-prob, ceil-rounded to 1, so
    // the break-even for a taker buy at 0.999999 is 1.000000: the trade can
    // NEVER be profitable net of fees. Pinned as-is — conservative rounding.
    expect(breakEvenTakerUsdcCollected(prob("0.999999"), RATE)).toBe(ONE);
  });

  it("share-collected: q* = ceil(p / (1 - f*(1-p))) — exact vectors", () => {
    expect(breakEvenTakerShareCollected(prob("0.5"), RATE)).toBe(518_135n);  // ceil(518134.715...)
    expect(breakEvenTakerShareCollected(prob("0.95"), RATE)).toBe(953_337n); // ceil(953336.678...)
    expect(breakEvenTakerShareCollected(prob("0.01"), RATE)).toBe(10_745n);  // ceil(10744.60...)
    expect(breakEvenTakerShareCollected(0n, RATE)).toBe(0n);
    expect(breakEvenTakerShareCollected(ONE, RATE)).toBe(ONE);
  });

  it("the two collection conventions differ by exactly 12 micro-prob at p=0.95", () => {
    const dUsdc = breakEvenTakerUsdcCollected(prob("0.95"), RATE);
    const dShares = breakEvenTakerShareCollected(prob("0.95"), RATE);
    expect(dShares - dUsdc).toBe(12n);
    expect(dShares > dUsdc).toBe(true); // share-collected is strictly more expensive
  });

  it("breakEvenTaker dispatches on the collection convention", () => {
    expect(breakEvenTaker(prob("0.95"), { ratePpm: RATE, collection: "usdc" }))
      .toBe(breakEvenTakerUsdcCollected(prob("0.95"), RATE));
    expect(breakEvenTaker(prob("0.95"), { ratePpm: RATE, collection: "shares" }))
      .toBe(breakEvenTakerShareCollected(prob("0.95"), RATE));
  });

  it("share-collected throws on a degenerate schedule (denominator <= 0)", () => {
    expect(() => breakEvenTakerShareCollected(0n, PPM)).toThrow("degenerate fee schedule");
    expect(() => breakEvenTakerShareCollected(prob("0.1"), 2n * PPM)).toThrow("degenerate fee schedule");
  });
});

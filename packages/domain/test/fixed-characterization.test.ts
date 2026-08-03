/**
 * BPAIR-002 characterization tests for packages/domain/src/fixed.ts.
 *
 * These tests pin the CURRENT behavior of the fixed-point primitives that the
 * pair-execution subsystem will build on. They assert what the code does
 * today, not what any spec says it should do. If one of these fails after a
 * refactor, the refactor changed observable semantics.
 *
 * Key finding pinned here: mulDiv's negative-value branch (rounding performed
 * in magnitude space, sign applied afterwards) currently agrees with true
 * mathematical floor/ceil/half-even on the exact rational (a*b)/d for ALL sign
 * combinations. The in-source comment ("magnitude rounds toward zero handled
 * below by sign flip") is misleading, but the arithmetic is correct; the
 * property test below keeps it that way.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  clampProb, formatFixed, mulDiv, ONE, parseFixed, prob, type Rounding,
} from "../src/index";

// ---------------------------------------------------------------------------
// Independent reference implementation (true mathematical rounding on the
// exact rational n/d). Written from scratch — NOT copied from src/fixed.ts.
// ---------------------------------------------------------------------------
function refFloorDiv(n: bigint, d: bigint): bigint {
  const q = n / d;
  const r = n % d;
  return r !== 0n && (r < 0n) !== (d < 0n) ? q - 1n : q;
}
function refMulDiv(a: bigint, b: bigint, d: bigint, mode: Rounding): bigint {
  const n = a * b;
  if (mode === "floor") return refFloorDiv(n, d);
  if (mode === "ceil") return -refFloorDiv(-n, d);
  // half-even: q = floor, rr = positive remainder in [0, |d|)
  const q = refFloorDiv(n, d);
  const den = d < 0n ? -d : d;
  const r = n - q * d;
  const rr = d < 0n ? -r : r;
  const twice = rr * 2n;
  if (twice > den) return q + 1n;
  if (twice < den) return q;
  return q % 2n === 0n ? q : q + 1n;
}

describe("mulDiv characterization — positive operands", () => {
  it("floor is the default mode", () => {
    expect(mulDiv(7n, 1n, 2n)).toBe(3n);
    expect(mulDiv(7n, 1n, 2n, "floor")).toBe(3n);
  });

  it("ceil rounds up on any remainder", () => {
    expect(mulDiv(7n, 1n, 2n, "ceil")).toBe(4n);
    expect(mulDiv(1n, 1n, 1_000_000n, "ceil")).toBe(1n); // tiny remainder still bumps
    expect(mulDiv(999_999n, 1n, 1_000_000n, "ceil")).toBe(1n);
  });

  it("exact division returns the same value in every mode", () => {
    for (const mode of ["floor", "ceil", "half-even"] as const) {
      expect(mulDiv(6n, 5n, 3n, mode)).toBe(10n);
      expect(mulDiv(0n, 123n, 7n, mode)).toBe(0n);
    }
  });

  it("half-even: non-tie remainders round to nearest", () => {
    expect(mulDiv(9n, 1n, 4n, "half-even")).toBe(2n); // 2.25 -> 2
    expect(mulDiv(11n, 1n, 4n, "half-even")).toBe(3n); // 2.75 -> 3
  });

  it("half-even: exact .5 ties go to the even quotient", () => {
    expect(mulDiv(1n, 1n, 2n, "half-even")).toBe(0n); // 0.5 -> 0
    expect(mulDiv(3n, 1n, 2n, "half-even")).toBe(2n); // 1.5 -> 2
    expect(mulDiv(5n, 1n, 2n, "half-even")).toBe(2n); // 2.5 -> 2
    expect(mulDiv(7n, 1n, 2n, "half-even")).toBe(4n); // 3.5 -> 4
    expect(mulDiv(9n, 1n, 2n, "half-even")).toBe(4n); // 4.5 -> 4
  });
});

describe("mulDiv characterization — NEGATIVE operands (the fragile branch)", () => {
  // These pin the exact current outputs. The implementation rounds the
  // magnitude and then flips the sign; today that lands on true mathematical
  // floor/ceil/half-even in every case below.
  it("floor of a negative result rounds toward -infinity (away from zero)", () => {
    expect(mulDiv(-7n, 1n, 2n, "floor")).toBe(-4n); // -3.5 -> -4
    expect(mulDiv(7n, -1n, 2n, "floor")).toBe(-4n);
    expect(mulDiv(7n, 1n, -2n, "floor")).toBe(-4n);
    expect(mulDiv(-1n, 1n, 3n, "floor")).toBe(-1n); // -0.333 -> -1
  });

  it("ceil of a negative result rounds toward zero", () => {
    expect(mulDiv(-7n, 1n, 2n, "ceil")).toBe(-3n); // -3.5 -> -3
    expect(mulDiv(7n, -1n, 2n, "ceil")).toBe(-3n);
    expect(mulDiv(7n, 1n, -2n, "ceil")).toBe(-3n);
    expect(mulDiv(-1n, 1n, 3n, "ceil")).toBe(0n); // -0.333 -> 0 (not -0n weirdness)
  });

  it("double negatives cancel; triple negative is negative (XOR of sign bits)", () => {
    expect(mulDiv(-7n, -1n, 2n, "floor")).toBe(3n);
    expect(mulDiv(-7n, -1n, 2n, "ceil")).toBe(4n);
    expect(mulDiv(-7n, 1n, -2n, "floor")).toBe(3n);
    expect(mulDiv(-7n, -1n, -2n, "floor")).toBe(-4n);
    expect(mulDiv(-7n, -1n, -2n, "ceil")).toBe(-3n);
  });

  it("half-even is symmetric about zero (ties to even magnitude)", () => {
    expect(mulDiv(-5n, 1n, 2n, "half-even")).toBe(-2n); // -2.5 -> -2
    expect(mulDiv(-7n, 1n, 2n, "half-even")).toBe(-4n); // -3.5 -> -4
    expect(mulDiv(-1n, 1n, 2n, "half-even")).toBe(0n); // -0.5 -> 0
    expect(mulDiv(-9n, 1n, 4n, "half-even")).toBe(-2n); // -2.25 -> -2
    expect(mulDiv(-11n, 1n, 4n, "half-even")).toBe(-3n); // -2.75 -> -3
    expect(mulDiv(5n, 1n, -2n, "half-even")).toBe(-2n); // negative via denominator
  });

  it("zero numerator with negative sign combination returns plain 0n", () => {
    expect(mulDiv(0n, 5n, -3n, "floor")).toBe(0n);
    expect(mulDiv(0n, -5n, 3n, "ceil")).toBe(0n);
    expect(mulDiv(-1n, 0n, 7n, "half-even")).toBe(0n);
  });

  it("exact negative division is exact in every mode", () => {
    for (const mode of ["floor", "ceil", "half-even"] as const) {
      expect(mulDiv(-6n, 1n, 2n, mode)).toBe(-3n);
      expect(mulDiv(6n, -5n, 3n, mode)).toBe(-10n);
    }
  });
});

describe("mulDiv characterization — division by zero and large values", () => {
  it("throws on zero denominator, even with zero numerator", () => {
    expect(() => mulDiv(1n, 1n, 0n)).toThrow("mulDiv: division by zero");
    expect(() => mulDiv(0n, 0n, 0n, "ceil")).toThrow("mulDiv: division by zero");
  });

  it("is exact for values far beyond 2^64 (no intermediate overflow)", () => {
    const a = 2n ** 128n + 1n;
    const b = 2n ** 127n + 3n;
    const d = 2n ** 63n - 1n;
    for (const mode of ["floor", "ceil", "half-even"] as const) {
      expect(mulDiv(a, b, d, mode)).toBe(refMulDiv(a, b, d, mode));
      expect(mulDiv(-a, b, d, mode)).toBe(refMulDiv(-a, b, d, mode));
    }
    // a known exact large case
    expect(mulDiv(10n ** 18n, 10n ** 18n, 10n ** 12n, "floor")).toBe(10n ** 24n);
  });

  it("property: mulDiv equals true mathematical rounding for all sign combinations", () => {
    const big = fc.bigInt({ min: -(2n ** 96n), max: 2n ** 96n });
    const den = fc.bigInt({ min: -(2n ** 96n), max: 2n ** 96n }).map((d) => (d === 0n ? 1n : d));
    const mode = fc.constantFrom<Rounding>("floor", "ceil", "half-even");
    fc.assert(
      fc.property(big, big, den, mode, (a, b, d, m) => mulDiv(a, b, d, m) === refMulDiv(a, b, d, m)),
      { numRuns: 2000 },
    );
  });

  it("property: floor <= half-even <= ceil, and ceil - floor <= 1", () => {
    const big = fc.bigInt({ min: -(2n ** 64n), max: 2n ** 64n });
    const den = big.map((d) => (d === 0n ? 1n : d));
    fc.assert(
      fc.property(big, big, den, (a, b, d) => {
        const fl = mulDiv(a, b, d, "floor");
        const he = mulDiv(a, b, d, "half-even");
        const ce = mulDiv(a, b, d, "ceil");
        return fl <= he && he <= ce && ce - fl <= 1n;
      }),
      { numRuns: 1000 },
    );
  });
});

describe("parseFixed/formatFixed characterization", () => {
  it("throws on excess NON-ZERO precision but silently accepts excess trailing zeros", () => {
    expect(() => parseFixed("1.1234567", 6)).toThrow("exceeds 6 decimal places");
    expect(parseFixed("1.1234560000", 6)).toBe(1_123_456n); // zeros beyond 6 dp are dropped
  });

  it("truncateExtra truncates (never rounds) excess precision", () => {
    expect(parseFixed("1.9999999", 6, { truncateExtra: true })).toBe(1_999_999n);
  });

  it("negative decimals parse and format round-trip; formatFixed trims trailing zeros by default", () => {
    expect(parseFixed("-0.5", 6)).toBe(-500_000n);
    expect(formatFixed(-500_000n, 6)).toBe("-0.5");
    expect(formatFixed(-500_000n, 6, false)).toBe("-0.500000");
    expect(formatFixed(0n, 6)).toBe("0");
  });

  it("rejects strings that are not plain decimals", () => {
    for (const s of ["1e6", "0x10", "1,000", ".5", "1.", "", "+1"]) {
      expect(() => parseFixed(s, 6)).toThrow();
    }
  });

  it("prob() enforces [0,1]; clampProb clamps silently", () => {
    expect(prob("0")).toBe(0n);
    expect(prob("1")).toBe(ONE);
    expect(() => prob("1.000001")).toThrow("prob out of [0,1]");
    expect(clampProb(-5n)).toBe(0n);
    expect(clampProb(ONE + 5n)).toBe(ONE);
  });
});

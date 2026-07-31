import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  applyCapChain, bankrollAfterLosses, costOfShares, fractionalKelly, fullKellyMaker,
  mulDiv, ppm, prob, roundSharesToLot, shares, sharesForStake, stakeFromFraction,
  targetReturnStakeFraction, toNumber, usdc,
} from "../src/index";

describe("target-return calculator (spec table)", () => {
  // required stake fraction for a 1% bankroll profit target: g*p/(1-p)
  const table: Array<[string, number]> = [
    ["0.75", 0.03],
    ["0.80", 0.04],
    ["0.82", 0.0456],
    ["0.83", 0.0488],
    ["0.85", 0.0567],
    ["0.90", 0.09],
    ["0.95", 0.19],
  ];
  for (const [p, expected] of table) {
    it(`1% target at ${p} requires risking ${(expected * 100).toFixed(2)}%`, () => {
      const f = targetReturnStakeFraction(ppm("0.01"), prob(p));
      expect(toNumber(f)).toBeCloseTo(expected, 3);
    });
  }

  it("1% target at 0.95 (19%) violates the very-aggressive 10% cap", () => {
    const f = targetReturnStakeFraction(ppm("0.01"), prob("0.95"));
    expect(f > ppm("0.10")).toBe(true);
  });
});

describe("kelly", () => {
  it("full Kelly maker = (q-p)/(1-p)", () => {
    expect(toNumber(fullKellyMaker(prob("0.60"), prob("0.50")))).toBeCloseTo(0.2, 6);
    expect(fullKellyMaker(prob("0.50"), prob("0.60"))).toBe(0n); // negative edge -> 0
  });
  it("fractional Kelly halves at 0.5 multiplier", () => {
    const full = fullKellyMaker(prob("0.60"), prob("0.50"));
    expect(toNumber(fractionalKelly(full, ppm("0.5")))).toBeCloseTo(0.1, 6);
  });
});

describe("cap chain", () => {
  it("identifies the binding cap", () => {
    const r = applyCapChain(ppm("0.19"), [
      { name: "profile_max", capPpm: ppm("0.10") },
      { name: "session_budget", capPpm: ppm("0.12") },
    ]);
    expect(r.finalPpm).toBe(ppm("0.10"));
    expect(r.binding).toBe("profile_max");
  });
  it("never exceeds any cap (property)", () => {
    fc.assert(
      fc.property(
        fc.bigInt(0n, 1_000_000n),
        fc.array(fc.bigInt(0n, 1_000_000n), { minLength: 1, maxLength: 5 }),
        (req, caps) => {
          const r = applyCapChain(req, caps.map((c, i) => ({ name: `c${i}`, capPpm: c })));
          return r.finalPpm <= req && caps.every((c) => r.finalPpm <= c);
        },
      ),
    );
  });
});

describe("loss-streak projection (spec numbers)", () => {
  it("five 10% losses leave ~59%, ten leave ~35%", () => {
    expect(toNumber(bankrollAfterLosses(ppm("0.10"), 5))).toBeCloseTo(0.59049, 4);
    expect(toNumber(bankrollAfterLosses(ppm("0.10"), 10))).toBeCloseTo(0.34868, 4);
  });
});

describe("shares/stake round trips", () => {
  it("cost of computed shares never exceeds stake", () => {
    fc.assert(
      fc.property(
        fc.bigInt(1n, 10_000_000_000n),  // up to 10k USDC
        fc.bigInt(10_000n, 990_000n),    // price 0.01..0.99
        (stake, p) => {
          const sh = sharesForStake(stake, p);
          return costOfShares(sh, p) <= stake + 1_000_000n / 1_000_000n * 1n; // ceil of one micro-share*price
        },
      ),
    );
  });
  it("lot rounding rounds down", () => {
    expect(roundSharesToLot(shares("12.345678"), shares("0.01"))).toBe(shares("12.34"));
  });
  it("stakeFromFraction floors", () => {
    expect(stakeFromFraction(usdc("1000"), ppm("0.05"))).toBe(usdc("50"));
  });
});

describe("mulDiv rounding", () => {
  it("ceil >= floor, difference at most 1", () => {
    fc.assert(
      fc.property(fc.bigInt(-1_000_000_000n, 1_000_000_000n), fc.bigInt(-1_000_000n, 1_000_000n), fc.bigInt(1n, 1_000_000n), (a, b, d) => {
        const f = mulDiv(a, b, d, "floor");
        const c = mulDiv(a, b, d, "ceil");
        return c >= f && c - f <= 1n;
      }),
    );
  });
  it("floor is exact division when divisible", () => {
    expect(mulDiv(10n, 6n, 3n)).toBe(20n);
  });
});

import { describe, expect, it } from "vitest";
import {
  GIST_MODES,
  REDDIT_FAVORED_SIDE_BANDS,
  REDDIT_LAG_ARM_AND_WATCH,
  detectBandRowDiffInconsistencies,
  detectFavoredSideCountGap,
  detectMomentumGapRoundingMismatch,
  drawdownAfterConsecutiveLosses,
  fractionToDecimalString,
  fractionToPercentString2dp,
  gistSafeModeFourLossDrawdown,
  reduceFraction,
} from "../src/index";

describe("(a) favored-side count gap: 4,442 displayed vs 4,569 claimed", () => {
  it("fires on the fixture data and returns the 127-decision gap", () => {
    const r = detectFavoredSideCountGap(REDDIT_FAVORED_SIDE_BANDS.data);
    expect(r.displayedSum).toBe(4442);
    expect(r.claimedDecisions).toBe(4569);
    expect(r.missingDecisions).toBe(127);
    expect(r.mismatch).toBe(true);
  });

  it("does not fire when rows account for every claimed decision", () => {
    const consistent = {
      ...REDDIT_FAVORED_SIDE_BANDS.data,
      claimedDecisions: 4442,
    };
    const r = detectFavoredSideCountGap(consistent);
    expect(r.missingDecisions).toBe(0);
    expect(r.mismatch).toBe(false);
  });

  it("also flags the 0.55–0.60 row whose printed -2.1pp differs from 57.1 - 59.3 = -2.2pp", () => {
    const inconsistencies = detectBandRowDiffInconsistencies(REDDIT_FAVORED_SIDE_BANDS.data);
    expect(inconsistencies).toEqual([
      { band: "0.55–0.60", printedDiffPpTenths: -21, computedDiffPpTenths: -22 },
    ]);
  });
});

describe("(b) momentum-side rounded gap: 74.8% vs 75.3% ask, reported -0.4pp", () => {
  it("fires on the fixture data: visible rounded gap is -0.5pp, not the reported -0.4pp", () => {
    const r = detectMomentumGapRoundingMismatch(REDDIT_LAG_ARM_AND_WATCH.data);
    expect(r.resolutionPctTenths).toBe(748);
    expect(r.askPctTenths).toBe(753);
    expect(r.visibleGapPpTenths).toBe(-5);
    expect(r.reportedGapPpTenths).toBe(-4);
    expect(r.reconciliationPpTenths).toBe(1);
    expect(r.mismatch).toBe(true);
  });

  it("does not fire when the reported gap matches the visible figures", () => {
    const r = detectMomentumGapRoundingMismatch({
      ...REDDIT_LAG_ARM_AND_WATCH.data,
      reportedGapPpTenths: -5,
    });
    expect(r.mismatch).toBe(false);
  });
});

describe("(c) gist 'safe' mode: 25% risk, four consecutive losses — exact rational math", () => {
  it("loses exactly 175/256 (0.68359375 ~ 68.36%) and retains 81/256 (0.31640625 ~ 31.64%)", () => {
    const r = gistSafeModeFourLossDrawdown();
    expect(r.riskPerTrade).toEqual({ numerator: 1n, denominator: 4n });
    expect(r.consecutiveLosses).toBe(4);
    expect(r.lost).toEqual({ numerator: 175n, denominator: 256n });
    expect(r.retained).toEqual({ numerator: 81n, denominator: 256n });
    expect(r.lostDecimal).toBe("0.68359375");
    expect(r.retainedDecimal).toBe("0.31640625");
    expect(r.lostPercent2dp).toBe("68.36");
    expect(r.retainedPercent2dp).toBe("31.64");
  });

  it("matches the brief's printed arithmetic and the GIST_MODES fixture, driven from the fixture's own risk fraction", () => {
    const safe = GIST_MODES.data.safe;
    const r = drawdownAfterConsecutiveLosses(safe.riskPerTrade, 4);
    expect(r.lostDecimal).toBe(safe.briefExactFourLossDrawdownAsPrinted); // "0.68359375"
    // The source's "approximately 68%" understates: the exact loss exceeds 68%.
    expect(r.lost.numerator * 100n > 68n * r.lost.denominator).toBe(true);
  });

  it("is exact for the general case", () => {
    expect(drawdownAfterConsecutiveLosses({ numerator: 1n, denominator: 4n }, 0).lost)
      .toEqual({ numerator: 0n, denominator: 1n });
    expect(drawdownAfterConsecutiveLosses({ numerator: 1n, denominator: 1n }, 1).lost)
      .toEqual({ numerator: 1n, denominator: 1n });
    // Unreduced input reduces: 2/8 == 1/4.
    expect(drawdownAfterConsecutiveLosses({ numerator: 2n, denominator: 8n }, 4).lost)
      .toEqual({ numerator: 175n, denominator: 256n });
  });

  it("rejects invalid inputs", () => {
    expect(() => drawdownAfterConsecutiveLosses({ numerator: 5n, denominator: 4n }, 1)).toThrow();
    expect(() => drawdownAfterConsecutiveLosses({ numerator: 1n, denominator: 4n }, 1.5)).toThrow();
    expect(() => drawdownAfterConsecutiveLosses({ numerator: 1n, denominator: 4n }, -1)).toThrow();
  });
});

describe("rational helpers", () => {
  it("reduceFraction normalizes sign and common factors", () => {
    expect(reduceFraction({ numerator: 2n, denominator: 8n })).toEqual({ numerator: 1n, denominator: 4n });
    expect(reduceFraction({ numerator: 3n, denominator: -6n })).toEqual({ numerator: -1n, denominator: 2n });
    expect(() => reduceFraction({ numerator: 1n, denominator: 0n })).toThrow();
  });

  it("fractionToDecimalString terminates exactly for power-of-2/5 denominators", () => {
    expect(fractionToDecimalString({ numerator: 175n, denominator: 256n }))
      .toEqual({ decimal: "0.68359375", exact: true });
    expect(fractionToDecimalString({ numerator: 5n, denominator: 4n }))
      .toEqual({ decimal: "1.25", exact: true });
    expect(fractionToDecimalString({ numerator: 3n, denominator: 1n }))
      .toEqual({ decimal: "3", exact: true });
  });

  it("flags non-terminating expansions instead of silently rounding", () => {
    const r = fractionToDecimalString({ numerator: 1n, denominator: 3n }, 8);
    expect(r.decimal).toBe("0.33333333");
    expect(r.exact).toBe(false);
  });

  it("fractionToPercentString2dp rounds half-up", () => {
    expect(fractionToPercentString2dp({ numerator: 175n, denominator: 256n })).toBe("68.36");
    expect(fractionToPercentString2dp({ numerator: 81n, denominator: 256n })).toBe("31.64");
    expect(fractionToPercentString2dp({ numerator: 1n, denominator: 2n })).toBe("50.00");
    expect(fractionToPercentString2dp({ numerator: 1n, denominator: 800n })).toBe("0.13"); // 0.125% -> half-up
  });
});

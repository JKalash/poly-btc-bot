import { describe, expect, it } from "vitest";
import { applyCalibration } from "../src/artifacts";
import { brierScore, expectedCalibrationError, logLoss, meanCi95 } from "../src/metrics";
import { evaluatePromotion, type PromotionCriteria, type PromotionEvidence } from "../src/promotion";

const CRITERIA: PromotionCriteria = { minSamples: 300, maxEce: 0.05, minNetEvLowerCi: 0 };

function goodEvidence(): PromotionEvidence {
  return {
    walkForward: { folds: 4, brier: 0.21, logLoss: 0.6, ece: 0.03, n: 500, purged: true, embargoMs: 60_000 },
    netEvPerCost: { mean: 0.04, ciLo: 0.01, ciHi: 0.07, n: 400 },
    frictions: { feesIncluded: true, spreadIncluded: true, latencyIncluded: true, adverseSelectionIncluded: true },
  };
}

describe("evaluatePromotion", () => {
  it("approves only complete, positive-lower-CI evidence", () => {
    const v = evaluatePromotion(goodEvidence(), CRITERIA);
    expect(v.approved).toBe(true);
    expect(v.reasons).toEqual([]);
  });

  it("REJECTS a positive MEAN with a non-positive lower CI (the core rule)", () => {
    const e = goodEvidence();
    e.netEvPerCost = { mean: 0.06, ciLo: -0.005, ciHi: 0.13, n: 400 };
    const v = evaluatePromotion(e, CRITERIA);
    expect(v.approved).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/lower 95% CI/);
  });

  it("rejects unpurged folds, missing frictions, and small samples — with every reason listed", () => {
    const e = goodEvidence();
    e.walkForward.purged = false;
    e.walkForward.n = 50;
    e.frictions.adverseSelectionIncluded = false;
    const v = evaluatePromotion(e, CRITERIA);
    expect(v.approved).toBe(false);
    expect(v.reasons.length).toBeGreaterThanOrEqual(3);
    expect(v.reasons.join("\n")).toMatch(/purged/);
    expect(v.reasons.join("\n")).toMatch(/adverse-selection/);
    expect(v.reasons.join("\n")).toMatch(/sample count 50/);
  });

  it("rejects excessive calibration error and NaN metrics", () => {
    const e1 = goodEvidence();
    e1.walkForward.ece = 0.09;
    expect(evaluatePromotion(e1, CRITERIA).approved).toBe(false);
    const e2 = goodEvidence();
    e2.walkForward.ece = NaN;
    expect(evaluatePromotion(e2, CRITERIA).approved).toBe(false);
  });
});

describe("metrics", () => {
  it("brier and log-loss score perfect and inverted predictions correctly", () => {
    const perfect = [{ p: 1, y: 1 as const }, { p: 0, y: 0 as const }];
    expect(brierScore(perfect)).toBe(0);
    expect(logLoss(perfect)).toBeCloseTo(0, 6);
    const inverted = [{ p: 0, y: 1 as const }, { p: 1, y: 0 as const }];
    expect(brierScore(inverted)).toBe(1);
    expect(logLoss(inverted)).toBeGreaterThan(10);
  });

  it("ECE is ~0 for calibrated predictions and large for systematic bias", () => {
    // calibrated: p=0.3 bucket realizes 30%, p=0.7 bucket realizes 70%
    const calibrated = [
      ...Array.from({ length: 100 }, (_, i) => ({ p: 0.3, y: (i < 30 ? 1 : 0) as 0 | 1 })),
      ...Array.from({ length: 100 }, (_, i) => ({ p: 0.7, y: (i < 70 ? 1 : 0) as 0 | 1 })),
    ];
    expect(expectedCalibrationError(calibrated, 2)).toBeLessThan(0.01);
    const biased = Array.from({ length: 200 }, (_, i) => ({ p: 0.9, y: (i < 100 ? 1 : 0) as 0 | 1 }));
    expect(expectedCalibrationError(biased, 2)).toBeGreaterThan(0.35);
  });

  it("meanCi95 brackets the mean and collapses sensibly at the edges", () => {
    const r = meanCi95([1, 2, 3, 4, 5]);
    expect(r.mean).toBe(3);
    expect(r.lo).toBeLessThan(3);
    expect(r.hi).toBeGreaterThan(3);
    expect(meanCi95([]).n).toBe(0);
    expect(meanCi95([7]).lo).toBe(-Infinity); // one sample proves nothing
  });
});

describe("applyCalibration", () => {
  it("interpolates an isotonic curve and clamps beyond the endpoints", () => {
    const art = { method: "isotonic" as const, curve: [{ x: 0.2, y: 0.1 }, { x: 0.8, y: 0.9 }], platt: null };
    expect(applyCalibration(art, 0.5)).toBeCloseTo(0.5, 9);
    expect(applyCalibration(art, 0)).toBe(0.1);
    expect(applyCalibration(art, 1)).toBe(0.9);
  });

  it("applies a Platt sigmoid", () => {
    const art = { method: "platt" as const, curve: null, platt: { a: -4, b: 2 } };
    expect(applyCalibration(art, 0.5)).toBeCloseTo(0.5, 9);
    expect(applyCalibration(art, 1)).toBeGreaterThan(0.5);
  });

  it("throws on malformed artifacts instead of guessing", () => {
    expect(() => applyCalibration({ method: "isotonic", curve: null, platt: null }, 0.5)).toThrow();
    expect(() => applyCalibration({ method: "platt", curve: null, platt: null }, 0.5)).toThrow();
  });
});

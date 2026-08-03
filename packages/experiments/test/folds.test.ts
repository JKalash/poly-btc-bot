import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { validateFolds, walkForwardFolds, type FoldPlan, type SampleWindow } from "../src/folds";

const PLAN: FoldPlan = { nFolds: 4, embargoMs: 60_000, purge: true, minTrainSamples: 5 };

/** 5-minute market windows back to back: sample i spans [i*300s, (i+1)*300s). */
function contiguousWindows(n: number, spanMs = 300_000): SampleWindow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `w${i}`,
    startMs: i * spanMs,
    endMs: (i + 1) * spanMs,
  }));
}

describe("walkForwardFolds", () => {
  it("produces strictly historical training sets with the embargo respected", () => {
    const samples = contiguousWindows(200);
    const folds = walkForwardFolds(samples, PLAN);
    expect(folds.length).toBeGreaterThan(0);
    for (const f of folds) {
      for (const id of f.trainIds) {
        const s = samples.find((x) => x.id === id)!;
        expect(s.endMs).toBeLessThanOrEqual(f.testStartMs - PLAN.embargoMs);
      }
      for (const id of f.testIds) {
        const s = samples.find((x) => x.id === id)!;
        expect(s.startMs).toBeGreaterThanOrEqual(f.testStartMs);
        expect(s.endMs).toBeLessThanOrEqual(f.testEndMs);
      }
    }
    expect(validateFolds(samples, folds, PLAN).ok).toBe(true);
  });

  it("LEAKAGE FIXTURE: overlapping windows crossing a fold boundary are purged from both sets", () => {
    // Long overlapping windows (each spans 3 base windows) — the classic
    // label-overlap leakage setup from combinatorial CV literature.
    const samples: SampleWindow[] = Array.from({ length: 120 }, (_, i) => ({
      id: `L${i}`,
      startMs: i * 300_000,
      endMs: i * 300_000 + 900_000, // 3x overlap
    }));
    const folds = walkForwardFolds(samples, PLAN);
    expect(folds.length).toBeGreaterThan(0);
    const v = validateFolds(samples, folds, PLAN);
    expect(v.ok).toBe(true);
    // Assert purge really removed boundary-crossers: for each fold, any sample
    // overlapping [testStart - embargo, testStart) must be in neither set.
    for (const f of folds) {
      const excludedZoneStart = f.testStartMs - PLAN.embargoMs;
      for (const s of samples) {
        const crossesBoundary = s.startMs < f.testStartMs && s.endMs > excludedZoneStart;
        if (crossesBoundary) {
          expect(f.trainIds).not.toContain(s.id);
          expect(f.testIds).not.toContain(s.id);
        }
      }
    }
  });

  it("validateFolds catches a deliberately leaked sample", () => {
    const samples = contiguousWindows(100);
    const folds = walkForwardFolds(samples, PLAN);
    const f = folds[folds.length - 1]!;
    // inject leakage: put a test sample into train
    const tampered = { ...f, trainIds: [...f.trainIds, f.testIds[0]!] };
    const v = validateFolds(samples, [tampered], PLAN);
    expect(v.ok).toBe(false);
    expect(v.violations.join("\n")).toMatch(/leakage|both train and test/);
  });

  it("drops folds whose training set is below minTrainSamples instead of fitting on scraps", () => {
    const samples = contiguousWindows(10);
    const folds = walkForwardFolds(samples, { ...PLAN, minTrainSamples: 8 });
    for (const f of folds) expect(f.trainIds.length).toBeGreaterThanOrEqual(8);
  });

  it("returns no folds for empty input and rejects inverted windows", () => {
    expect(walkForwardFolds([], PLAN)).toEqual([]);
    expect(() => walkForwardFolds([{ id: "bad", startMs: 10, endMs: 5 }], PLAN)).toThrow();
  });

  it("PROPERTY: no fold ever trains on a sample ending after its embargo boundary", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            start: fc.integer({ min: 0, max: 10_000_000 }),
            len: fc.integer({ min: 1, max: 2_000_000 }),
          }),
          { minLength: 3, maxLength: 150 },
        ),
        fc.integer({ min: 2, max: 6 }),
        fc.integer({ min: 0, max: 500_000 }),
        (raw, nFolds, embargoMs) => {
          const samples: SampleWindow[] = raw.map((r, i) => ({ id: `s${i}`, startMs: r.start, endMs: r.start + r.len }));
          const plan: FoldPlan = { nFolds, embargoMs, purge: true, minTrainSamples: 1 };
          const folds = walkForwardFolds(samples, plan);
          return validateFolds(samples, folds, plan).ok;
        },
      ),
    );
  });
});

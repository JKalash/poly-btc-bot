import { describe, expect, it } from "vitest";
import { computeTimingStats, type ResolvedMarketRow } from "../src/timing";

// deterministic synthetic month: 12 buckets x 240 markets, minute :45 biased up
function synthMonth(): ResolvedMarketRow[] {
  const rows: ResolvedMarketRow[] = [];
  const base = 1_783_000_000 - (1_783_000_000 % 300);
  for (let i = 0; i < 12 * 240; i++) {
    const endEpoch = base + i * 300;
    const minute = Math.floor(endEpoch / 60) % 60;
    const upBias = minute === 45 ? 0.62 : 0.5;
    // deterministic well-distributed hash (GLSL-style)
    const s = Math.sin(i * 12.9898) * 43758.5453;
    const h = s - Math.floor(s);
    rows.push({
      endEpoch,
      outcome: h < upBias ? "UP" : "DOWN",
      volumeUsd: 50_000 + (i % 100) * 100,
      absMoveBps: minute % 15 === 0 ? 4 + (i % 5) : 5 + (i % 6),
    });
  }
  return rows;
}

describe("timing lab statistics", () => {
  const result = computeTimingStats(synthMonth(), 30);

  it("produces 12 minute buckets plus quarter/other/all", () => {
    expect(result.buckets.length).toBe(15);
    const names = result.buckets.map((b) => b.bucket);
    expect(names).toContain("45");
    expect(names).toContain("quarter");
    expect(names).toContain("all");
  });

  it("detects the planted :45 bias with corrected p-values", () => {
    const b45 = result.buckets.find((b) => b.bucket === "45")!;
    expect(b45.upRate).toBeGreaterThan(0.55);
    expect(b45.pRaw!).toBeLessThan(0.01);
    expect(b45.pBonferroni!).toBeLessThan(0.1);
    expect(b45.pBonferroni!).toBeGreaterThanOrEqual(b45.pRaw!); // correction only increases p
    expect(b45.pBh!).toBeGreaterThanOrEqual(b45.pRaw!);
    expect(b45.wilsonLo).toBeLessThan(b45.upRate);
    expect(b45.wilsonHi).toBeGreaterThan(b45.upRate);
  });

  it("unbiased buckets stay insignificant after correction", () => {
    const b10 = result.buckets.find((b) => b.bucket === "10")!;
    expect(b10.pBonferroni ?? 1).toBeGreaterThan(0.05);
  });

  it("quarter-hour buckets show the planted calmness in move magnitudes", () => {
    const q = result.buckets.find((b) => b.bucket === "quarter")!;
    const o = result.buckets.find((b) => b.bucket === "other")!;
    expect(q.medianAbsMoveBps!).toBeLessThan(o.medianAbsMoveBps!);
  });

  it("global chi-square is reported", () => {
    expect(result.globalChi2.df).toBe(11);
    expect(result.globalChi2.p).toBeGreaterThanOrEqual(0);
    expect(result.globalChi2.p).toBeLessThanOrEqual(1);
  });
});

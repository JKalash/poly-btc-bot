import { describe, expect, it } from "vitest";
import {
  ENGINE_TRANSITIONS, MARKET_TRANSITIONS, assertTransition, benjaminiHochberg,
  bonferroni, canTransition, chiSquareSf, chiSquareUpDownBuckets, closingMinuteBucket,
  isQuarterHourClose, isTopOfHourClose, mannWhitney, normCdf, sessionLabel,
  slotStartEpoch, twoProportionTest, wilsonInterval,
} from "../src/index";

describe("minute buckets", () => {
  it("assigns closing minute buckets from end epoch", () => {
    // 2026-07-30 23:45:00 UTC
    const t = Date.UTC(2026, 6, 30, 23, 45, 0) / 1000;
    expect(closingMinuteBucket(t)).toBe("45");
    expect(isQuarterHourClose(t)).toBe(true);
    expect(isTopOfHourClose(t)).toBe(false);
    const t2 = Date.UTC(2026, 6, 30, 23, 0, 0) / 1000;
    expect(closingMinuteBucket(t2)).toBe("00");
    expect(isTopOfHourClose(t2)).toBe(true);
    const t3 = Date.UTC(2026, 6, 30, 23, 35, 0) / 1000;
    expect(closingMinuteBucket(t3)).toBe("35");
    expect(isQuarterHourClose(t3)).toBe(false);
  });
  it("slot alignment", () => {
    expect(slotStartEpoch(1785454501)).toBe(1785454500);
    expect(slotStartEpoch(1785454500)).toBe(1785454500);
  });
  it("session labels", () => {
    expect(sessionLabel(Date.UTC(2026, 6, 30, 3, 0, 0) / 1000)).toBe("asia");
    expect(sessionLabel(Date.UTC(2026, 6, 30, 14, 0, 0) / 1000)).toBe("eu_us_overlap");
    expect(sessionLabel(Date.UTC(2026, 6, 30, 22, 0, 0) / 1000)).toBe("low_liquidity");
  });
});

describe("state machines", () => {
  it("happy path is legal", () => {
    const path = ["DISCOVERED", "WARMING", "OBSERVING", "CANDIDATE", "RISK_APPROVED", "ORDER_PENDING", "RESTING", "PARTIAL", "FILLED", "RESOLVED", "RECONCILED"] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(MARKET_TRANSITIONS, path[i]!, path[i + 1]!)).toBe(true);
    }
  });
  it("illegal transitions throw", () => {
    expect(() => assertTransition(MARKET_TRANSITIONS, "RESOLVED", "RESTING", "market")).toThrow();
    expect(() => assertTransition(MARKET_TRANSITIONS, "OBSERVING", "FILLED", "market")).toThrow();
  });
  it("any active state can halt or go stale", () => {
    for (const s of ["WARMING", "OBSERVING", "CANDIDATE", "RESTING", "PARTIAL"] as const) {
      expect(canTransition(MARKET_TRANSITIONS, s, "HALTED")).toBe(true);
      expect(canTransition(MARKET_TRANSITIONS, s, "STALE")).toBe(true);
    }
  });
  it("live arming requires the deliberate path", () => {
    expect(canTransition(ENGINE_TRANSITIONS, "PAPER", "LIVE_ARMED")).toBe(false);
    expect(canTransition(ENGINE_TRANSITIONS, "LIVE_DISARMED", "LIVE_ARMING")).toBe(true);
    expect(canTransition(ENGINE_TRANSITIONS, "LIVE_ARMING", "LIVE_ARMED")).toBe(true);
  });
});

describe("stats", () => {
  it("normCdf sanity", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
  });
  it("wilson interval brackets the point estimate", () => {
    const { lo, hi, p } = wilsonInterval(1480, 2879); // spec quarter-hour data ~51.4%
    expect(p).toBeCloseTo(0.5140, 3);
    expect(lo).toBeLessThan(p);
    expect(hi).toBeGreaterThan(p);
    expect(hi - lo).toBeLessThan(0.04);
  });
  it("reproduces the spec's quarter-vs-other test (z=1.72, p~0.0855)", () => {
    // 51.41% of 2879 vs 49.44% of 5758
    const k1 = Math.round(0.5141 * 2879);
    const k2 = Math.round(0.4944 * 5758);
    const { z, p } = twoProportionTest(k1, 2879, k2, 5758);
    expect(z).toBeCloseTo(1.72, 1);
    expect(p).toBeCloseTo(0.0855, 2);
  });
  it("chi-square survival sanity: sf(13.05, 11) ~ 0.29", () => {
    expect(chiSquareSf(13.05, 11)).toBeCloseTo(0.289, 2);
  });
  it("bonferroni: the spec's :45 bucket (p=0.0276, m=12) -> ~0.33, not significant", () => {
    expect(bonferroni(0.0276, 12)).toBeCloseTo(0.3312, 4);
  });
  it("benjamini-hochberg is monotone and bounded", () => {
    const adj = benjaminiHochberg([0.001, 0.02, 0.03, 0.5]);
    expect(adj[0]).toBeLessThanOrEqual(adj[1]!);
    expect(Math.max(...adj)).toBeLessThanOrEqual(1);
  });
  it("chi-square bucket test detects nothing on uniform data", () => {
    const buckets = Array.from({ length: 12 }, () => ({ up: 360, n: 720 }));
    const { p } = chiSquareUpDownBuckets(buckets);
    expect(p).toBeGreaterThan(0.99);
  });
  it("mann-whitney separates shifted samples", () => {
    const a = Array.from({ length: 200 }, (_, i) => i % 10);
    const b = Array.from({ length: 200 }, (_, i) => (i % 10) + 2);
    expect(mannWhitney(a, b).p).toBeLessThan(0.001);
  });
});

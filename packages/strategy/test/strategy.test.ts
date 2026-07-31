import { describe, expect, it } from "vitest";
import { ONE, prob, type MarketRef, type ReferenceTick } from "@b5p/domain";
import {
  BookState, TickBuffer, bookBaselineModel, chainlinkDirection, complementConsistency,
  computeFeatures, conservativeProbabilityForSide, distanceVolHeuristicModel,
  evaluateGates, studentT3Cdf, type GateConfig,
} from "../src/index";

const T0 = 1_785_000_000_000; // fixed test epoch ms

function tick(offsetSec: number, value: number): ReferenceTick {
  return {
    source: "chainlink",
    symbol: "btc/usd",
    value,
    sourceTsMs: T0 + offsetSec * 1000,
    receivedTsMs: T0 + offsetSec * 1000 + 40,
  };
}

function warmBuffer(base: number, drift = 0, noiseAmp = 5): TickBuffer {
  const buf = new TickBuffer();
  for (let s = -180; s <= 0; s++) {
    // deterministic pseudo-noise
    const noise = noiseAmp * Math.sin(s * 1.7) * Math.cos(s * 0.31);
    buf.push(tick(s, base + drift * (s + 180) + noise));
  }
  return buf;
}

function makeBooks(upBid: string, upAsk: string): { up: BookState; down: BookState } {
  const up = new BookState("up-token");
  up.applySnapshot(
    [{ price: upBid, size: "500" }, { price: "0.50", size: "800" }, { price: "0.45", size: "1000" }],
    [{ price: upAsk, size: "400" }, { price: "0.60", size: "700" }, { price: "0.65", size: "900" }],
    T0 - 200, T0 - 150,
  );
  const down = new BookState("down-token");
  const downBid = (1 - Number(upAsk)).toFixed(2);
  const downAsk = (1 - Number(upBid)).toFixed(2);
  down.applySnapshot(
    [{ price: downBid, size: "450" }],
    [{ price: downAsk, size: "350" }],
    T0 - 200, T0 - 150,
  );
  return { up, down };
}

const market: MarketRef = {
  marketId: "m1", eventId: "e1", conditionId: "0xc", slug: "btc-updown-5m-test",
  upTokenId: "up-token", downTokenId: "down-token",
  startEpoch: Math.floor(T0 / 1000) - 210, // 210s elapsed, 90s remaining
  endEpoch: Math.floor(T0 / 1000) + 90,
};

function featuresFor(chainNow: number, priceToBeat: number, upBid = "0.55", upAsk = "0.56") {
  const { up, down } = makeBooks(upBid, upAsk);
  const chainlink = warmBuffer(chainNow);
  const binance = warmBuffer(chainNow + 4);
  return computeFeatures({
    nowMs: T0, market, chainlink, binance, upBook: up, downBook: down,
    priceToBeat, warmupSeconds: 120, chainlinkMaxAgeMs: 1500, bookMaxAgeMs: 1000,
  });
}

describe("TickBuffer", () => {
  it("computes realized vol and detects crossings", () => {
    const buf = warmBuffer(64000);
    expect(buf.realizedVolBps(T0, 60_000)).toBeGreaterThan(0);
    const crossings = buf.crossings(T0, 120_000, 64000);
    expect(crossings.count).toBeGreaterThan(0);
    expect(crossings.minAbsDistanceBps).not.toBeNull();
  });
  it("atOrBefore finds the boundary tick", () => {
    const buf = warmBuffer(64000);
    const t = buf.atOrBefore(T0 - 10_000);
    expect(t).not.toBeNull();
    expect(t!.sourceTsMs).toBeLessThanOrEqual(T0 - 10_000);
  });
  it("evicts ticks past max age", () => {
    const buf = new TickBuffer(10_000);
    buf.push(tick(-60, 1));
    buf.push(tick(0, 2));
    expect(buf.size).toBe(1);
  });
});

describe("BookState", () => {
  it("maintains best bid/ask, spread, mid and applies level updates", () => {
    const { up } = makeBooks("0.55", "0.56");
    expect(up.bestBid()).toBe(prob("0.55"));
    expect(up.bestAsk()).toBe(prob("0.56"));
    expect(up.spread()).toBe(prob("0.01"));
    up.applyLevelUpdate("0.55", "0", "BUY", T0, T0); // remove best bid level
    expect(up.bestBid()).toBe(prob("0.50"));
    up.applyLevelUpdate("0.57", "100", "BUY", T0, T0);
    expect(up.bestBid()).toBe(prob("0.57"));
  });
  it("computes taker impact walking the asks", () => {
    const { up } = makeBooks("0.55", "0.56");
    const impact = up.takerBuyImpact(500n * 1_000_000n); // 400@0.56 + 100@0.60
    expect(impact).not.toBeNull();
    expect(Number(impact!.avgPrice6) / 1e6).toBeCloseTo((400 * 0.56 + 100 * 0.6) / 500, 4);
    expect(up.takerBuyImpact(10_000n * 1_000_000n)).toBeNull(); // book too thin
  });
  it("complement consistency near zero for a coherent two-sided market", () => {
    const { up, down } = makeBooks("0.55", "0.56");
    expect(complementConsistency(up, down)!).toBeLessThan(0.02);
  });
});

describe("features", () => {
  it("computes signed distance and direction (tie resolves UP)", () => {
    const f = featuresFor(64100, 64000);
    expect(f.distanceUsd).toBeCloseTo(100, 6);
    expect(f.distanceBps).toBeCloseTo((100 / 64000) * 10_000, 3);
    expect(chainlinkDirection(f)).toBe("UP");
    const flat = featuresFor(64000, 64000);
    expect(chainlinkDirection({ ...flat, distanceUsd: 0 })).toBe("UP"); // >= rule
    const below = featuresFor(63900, 64000);
    expect(chainlinkDirection(below)).toBe("DOWN");
  });
  it("degrades data quality when price-to-beat missing", () => {
    const { up, down } = makeBooks("0.55", "0.56");
    const f = computeFeatures({
      nowMs: T0, market, chainlink: warmBuffer(64000), binance: warmBuffer(64004),
      upBook: up, downBook: down, priceToBeat: null,
      warmupSeconds: 120, chainlinkMaxAgeMs: 1500, bookMaxAgeMs: 1000,
    });
    expect(f.dataQualityScore).toBeLessThan(0.2);
  });
});

describe("models", () => {
  it("t3 CDF sanity", () => {
    expect(studentT3Cdf(0)).toBeCloseTo(0.5, 9);
    expect(studentT3Cdf(10)).toBeGreaterThan(0.99);
    expect(studentT3Cdf(-10)).toBeLessThan(0.01);
  });
  it("book baseline probability equals mid; never live-approved", () => {
    const f = featuresFor(64100, 64000);
    const est = bookBaselineModel.estimate(f)!;
    expect(Number(est.probability) / 1e6).toBeCloseTo(0.555, 3);
    expect(est.approvedForLive).toBe(false);
    expect(bookBaselineModel.approvedForLive).toBe(false);
  });
  it("heuristic model is explicitly uncalibrated and never live-approved", () => {
    const f = featuresFor(64150, 64000);
    const est = distanceVolHeuristicModel.estimate(f);
    expect(distanceVolHeuristicModel.version).toContain("UNCALIBRATED");
    expect(distanceVolHeuristicModel.approvedForLive).toBe(false);
    if (est) {
      expect(est.probability > ONE / 2n).toBe(true); // above threshold -> UP more likely
      expect(est.uncertainty).toBeGreaterThan(0.1);
    }
  });
  it("conservative probability is below the point estimate and penalized", () => {
    const f = featuresFor(64100, 64000);
    const est = bookBaselineModel.estimate(f)!;
    const cons = conservativeProbabilityForSide(est, "UP");
    expect(cons < est.probability).toBe(true);
    const consDown = conservativeProbabilityForSide(est, "DOWN");
    expect(consDown < ONE - est.probability).toBe(true);
  });
});

describe("gates", () => {
  const cfg: GateConfig = {
    strategyVersion: "book_distance_v1",
    candidateSecondsRemainingMin: 60,
    candidateSecondsRemainingMax: 120,
    minConservativeEdge: 0.02,
    maxSpread: 0.02,
    minDepthShares: 100,
    minAbsDistanceZ: 0.5,
    priceImprovementTicks: 1,
    tickSize6: prob("0.01"),
    minuteBucketStandaloneSignal: false,
  };

  it("produces a candidate when everything aligns", () => {
    const f = featuresFor(64300, 64000); // strong up distance
    const est = distanceVolHeuristicModel.estimate(f);
    const d = evaluateGates(f, est, cfg);
    expect(d.side).toBe("UP");
    expect(d.candidate).toBe(true);
    expect(d.desiredMakerPrice6).not.toBeNull();
    // spread is one tick (0.55/0.56): improving would cross, so join the best bid
    expect(d.desiredMakerPrice6).toBe(prob("0.55"));
  });

  it("improves the bid by one tick when the spread allows it", () => {
    const f = featuresFor(64300, 64000, "0.53", "0.55"); // 2-tick spread, within maxSpread
    const d = evaluateGates(f, distanceVolHeuristicModel.estimate(f), cfg);
    expect(d.desiredMakerPrice6).toBe(prob("0.54")); // 0.53 + one tick, still below 0.55
  });

  it("rejects outside the candidate window with a readable checklist", () => {
    const f = { ...featuresFor(64300, 64000), secondsRemaining: 30 };
    const est = distanceVolHeuristicModel.estimate(f);
    const d = evaluateGates(f, est, cfg);
    expect(d.candidate).toBe(false);
    const win = d.checks.find((c) => c.name === "candidate_window")!;
    expect(win.pass).toBe(false);
    expect(win.value).toContain("30s");
  });

  it("rejects when model and chainlink disagree on direction", () => {
    const f = featuresFor(64100, 64000, "0.30", "0.31"); // book says DOWN, chainlink says UP
    const est = bookBaselineModel.estimate(f);
    const d = evaluateGates(f, est, cfg);
    expect(d.candidate).toBe(false);
    expect(d.checks.find((c) => c.name === "direction_agreement")!.pass).toBe(false);
  });

  it("never uses the minute bucket as a standalone signal", () => {
    const f = featuresFor(64300, 64000);
    const d = evaluateGates(f, distanceVolHeuristicModel.estimate(f), cfg);
    const check = d.checks.find((c) => c.name === "minute_bucket_not_standalone")!;
    expect(check.requirement).toContain("never authorizes");
  });
});

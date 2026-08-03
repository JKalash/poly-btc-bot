import { describe, expect, it } from "vitest";
import { prob, type ReferenceTick } from "@b5p/domain";
import {
  COMPOSITE_WEIGHTS, STRATEGY_PRESETS, TickBuffer, aggregateCloses, computeIndicators,
  ema, presetAllowsMode, rsi, type Candle, type PresetContext,
} from "../src/index";

const T0 = 1_785_000_000_000;

function candleSeries(seconds: number, priceAt: (i: number) => number, volumeAt: (i: number) => number = () => 1): Candle[] {
  return Array.from({ length: seconds }, (_, i) => {
    const p = priceAt(i);
    return { openTimeMs: T0 - (seconds - i) * 1000, open: p, high: p, low: p, close: p, volume: volumeAt(i) };
  });
}

function binTicks(values: number[]): TickBuffer {
  const buf = new TickBuffer();
  values.forEach((v, i) => {
    const t: ReferenceTick = {
      source: "binance", symbol: "btcusdt", value: v,
      sourceTsMs: T0 - (values.length - i) * 1000, receivedTsMs: T0 - (values.length - i) * 1000 + 20,
    };
    buf.push(t);
  });
  return buf;
}

describe("primitive indicators", () => {
  it("ema needs enough data and follows trend", () => {
    expect(ema([1, 2, 3], 5)).toBeNull();
    const rising = Array.from({ length: 50 }, (_, i) => 100 + i);
    expect(ema(rising, 9)!).toBeGreaterThan(ema(rising, 21)!);
  });
  it("rsi extremes", () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(rsi(up, 14)!).toBeGreaterThan(90);
    const down = Array.from({ length: 30 }, (_, i) => 100 - i);
    expect(rsi(down, 14)!).toBeLessThan(10);
  });
  it("aggregates 1s candles into N-second closes", () => {
    const c = candleSeries(10, (i) => i);
    expect(aggregateCloses(c, 5)).toEqual([4, 9]);
  });
});

describe("composite score (gist weights)", () => {
  const windowStart = Math.floor(T0 / 1000) - 290; // window opened 290s ago

  it("window delta dominates: strong up-move since open -> UP with high confidence", () => {
    const candles = candleSeries(400, (i) => 64000 + Math.max(0, i - 110) * 0.5); // rising after window open
    const ind = computeIndicators({
      nowMs: T0, windowStartEpochSec: windowStart, candles1s: candles,
      binanceTicks: binTicks(candles.slice(-30).map((c) => c.close)), candleSource: "BINANCE_KLINES",
    });
    expect(ind.direction).toBe("UP");
    expect(ind.windowDeltaPct).toBeGreaterThan(0.1);
    expect(ind.confidence).toBeGreaterThan(0.3);
    expect(COMPOSITE_WEIGHTS.windowDelta).toBeGreaterThanOrEqual(5);
  });

  it("flat tape -> no direction", () => {
    const candles = candleSeries(400, () => 64000);
    const ind = computeIndicators({
      nowMs: T0, windowStartEpochSec: windowStart, candles1s: candles,
      binanceTicks: binTicks(candles.slice(-30).map((c) => c.close)), candleSource: "BINANCE_KLINES",
    });
    expect(ind.direction).toBeNull();
    expect(ind.confidence).toBeLessThan(0.01);
  });

  it("volume surge amplifies but never creates direction", () => {
    const flat = candleSeries(400, () => 64000, (i) => (i > 390 ? 100 : 1));
    const ind = computeIndicators({
      nowMs: T0, windowStartEpochSec: windowStart, candles1s: flat,
      binanceTicks: binTicks(flat.slice(-30).map((c) => c.close)), candleSource: "BINANCE_KLINES",
    });
    expect(ind.volumeSurgeRatio!).toBeGreaterThan(5);
    expect(ind.direction).toBeNull(); // still flat
  });
});

describe("late-snipe preset governance", () => {
  it("is paper/shadow only — live is refused in code, not config", () => {
    const preset = STRATEGY_PRESETS.late_snipe_composite_v1!;
    expect(presetAllowsMode(preset, "paper")).toBe(true);
    expect(presetAllowsMode(preset, "shadow")).toBe(true);
    expect(presetAllowsMode(preset, "live")).toBe(false);
  });
  it("book_distance is maker post-only; late snipe is taker", () => {
    expect(STRATEGY_PRESETS.book_distance_v1!.style).toBe("maker_post_only");
    expect(STRATEGY_PRESETS.late_snipe_composite_v1!.style).toBe("taker_fak");
  });
  it("surfaces the one-loss-erases-N-wins arithmetic in its checklist", () => {
    const ctx: PresetContext = {
      candidateSecondsRemainingMin: 60, candidateSecondsRemainingMax: 120,
      maxSpread: 0.02, minDepthShares: 100, minAbsDistanceZ: 0.5,
      priceImprovementTicks: 1, tickSize6: prob("0.01"),
      probabilityModelKey: "book_baseline",
      lateSnipe: { snipeSecondsRemainingMin: 5, snipeSecondsRemainingMax: 30, minConfidence: 0.3, maxPrice: 0.97 },
    };
    // minimal feature set: not warmed, missing everything -> not a candidate, but checklist exists
    const f = {
      tsMs: T0, startEpoch: 0, endEpoch: Math.floor(T0 / 1000) + 10, secondsElapsed: 290, secondsRemaining: 10,
      utcHour: 0, closingMinuteBucket: "00", quarterHourClose: true, topOfHourClose: true, dayOfWeek: 1, session: "asia",
      chainlinkNow: null, chainlinkAgeMs: null, priceToBeat: null, distanceUsd: null, distanceBps: null,
      velocityBpsPerSec: null, accelerationBpsPerSec2: null, crossings120s: 0, lastCrossAgoMs: null,
      minAbsDistanceBps120s: null, realizedVolBps: {}, ewmaVolBpsPerSqrtSec: null, highLowRangeBps60s: null,
      estRemainingMoveStdBps: null, distanceZ: null, binanceNow: null, binanceAgeMs: null,
      binanceMinusChainlinkUsd: null, binanceMinusChainlinkBps: null, chainlinkMedianGapMs: null,
      chainlinkMaxGapMs120s: null, upBestBid: null, upBestAsk: null, upMid: null, upSpread: null,
      upMicroprice: null, upImbalanceTop5: null, upDepthBidTop5: null, upDepthAskTop5: null,
      downBestBid: null, downBestAsk: null, bookAgeMs: null, downBookAgeMs: null, complementInconsistency: null,
      upQuoteFlips: 0, lastTradePriceUp: null, lastTradeAgoMs: null, indicators: null,
      warmedUp: false, dataQualityScore: 0,
    };
    const d = STRATEGY_PRESETS.late_snipe_composite_v1!.evaluate(f, ctx);
    expect(d.candidate).toBe(false);
    expect(d.checks.find((c) => c.name === "late_favorite_warning")).toBeDefined();
    expect(d.checks.find((c) => c.name === "chainlink_confirmation")?.requirement ?? "").toContain("never override");
  });
});

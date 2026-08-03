import { describe, expect, it } from "vitest";
import { SOURCE_REPRODUCTION_STRATEGIES, validateConfig } from "@b5p/config";
import { prob, type MarketRef, type ReferenceTick } from "@b5p/domain";
import {
  BookState, FADE_CLAIMED_REVERSAL_RATE_BY_YEAR, FADE_MAX_ENTRY_PRICE, FADE_MIN_RUN_BLOCKS,
  FADE_MIN_RUN_MOVE_PCT, FADE_POOLED_REVERSAL_RATE, FADE_WEAKEST_YEAR_RATE, STRATEGY_PRESETS,
  TickBuffer, computeFeatures, extendedMoveFadeEstimate, presetAllowsMode,
  type ExtendedMoveFadePriorRun, type PresetContext,
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

function warmBuffer(base: number): TickBuffer {
  const buf = new TickBuffer();
  for (let s = -180; s <= 0; s++) {
    const noise = 5 * Math.sin(s * 1.7) * Math.cos(s * 0.31);
    buf.push(tick(s, base + noise));
  }
  return buf;
}

function makeBooks(upBid: string, upAsk: string): { up: BookState; down: BookState } {
  const up = new BookState("up-token");
  up.applySnapshot(
    [{ price: upBid, size: "500" }, { price: "0.30", size: "800" }, { price: "0.25", size: "1000" }],
    [{ price: upAsk, size: "400" }, { price: "0.70", size: "700" }, { price: "0.75", size: "900" }],
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

// Fresh window: 10s elapsed, 290s remaining — inside the fade's entry window.
const market: MarketRef = {
  marketId: "m1", eventId: "e1", conditionId: "0xc", slug: "btc-updown-5m-test",
  upTokenId: "up-token", downTokenId: "down-token",
  startEpoch: Math.floor(T0 / 1000) - 10,
  endEpoch: Math.floor(T0 / 1000) + 290,
};

function featuresFor(chainNow: number, priceToBeat: number, upBid = "0.50", upAsk = "0.52", mkt: MarketRef = market) {
  const { up, down } = makeBooks(upBid, upAsk);
  return computeFeatures({
    nowMs: T0, market: mkt, chainlink: warmBuffer(chainNow), binance: warmBuffer(chainNow + 4),
    upBook: up, downBook: down,
    priceToBeat, warmupSeconds: 120, chainlinkMaxAgeMs: 1500, bookMaxAgeMs: 1000,
  });
}

const RUN_UP: ExtendedMoveFadePriorRun = { blocks: 4, direction: "UP", cumulativeMovePct: 1.1 };

function ctxWith(fade?: PresetContext["extendedMoveFade"]): PresetContext {
  return {
    candidateSecondsRemainingMin: 60, candidateSecondsRemainingMax: 120,
    maxSpread: 0.02, minDepthShares: 100, minAbsDistanceZ: 0.5,
    priceImprovementTicks: 1, tickSize6: prob("0.01"),
    probabilityModelKey: "book_baseline",
    lateSnipe: { snipeSecondsRemainingMin: 5, snipeSecondsRemainingMax: 30, minConfidence: 0.3, maxPrice: 0.97 },
    ...(fade !== undefined ? { extendedMoveFade: fade } : {}),
  };
}

const preset = STRATEGY_PRESETS.extended_move_fade_v1!;

describe("extended_move_fade_v1 governance", () => {
  it("is registered under its config-facing version string", () => {
    expect(preset).toBeDefined();
    expect(preset.version).toBe("extended_move_fade_v1");
    expect(preset.style).toBe("maker_post_only");
    expect(SOURCE_REPRODUCTION_STRATEGIES).toContain("extended_move_fade_v1");
  });

  it("is paper/shadow only — live is refused in code, not config", () => {
    expect(presetAllowsMode(preset, "observe")).toBe(true);
    expect(presetAllowsMode(preset, "paper")).toBe(true);
    expect(presetAllowsMode(preset, "shadow")).toBe(true);
    expect(presetAllowsMode(preset, "live")).toBe(false);
    expect(preset.allowedModes).not.toContain("live");
  });

  it("a config requesting it for live mode is rejected by validateConfig", () => {
    const res = validateConfig({
      app: { mode: "live" },
      strategy: { active_version: "extended_move_fade_v1" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path === "strategy.active_version")).toBe(true);
    }
  });
});

describe("extended_move_fade_v1 decisions", () => {
  it("fades a qualifying UP run: DOWN candidate, post-only at <= 0.50, conservative band below the coin flip", () => {
    const f = featuresFor(64000, 64000);
    const d = preset.evaluate(f, ctxWith({ priorRun: RUN_UP }));
    expect(d.candidate).toBe(true);
    expect(d.side).toBe("DOWN"); // fade opposes the run
    // down book: bid 0.48 / ask 0.50 -> improve one tick to 0.49, still under the 0.50 cap
    expect(d.desiredMakerPrice6).toBe(prob("0.49"));
    expect(Number(d.desiredMakerPrice6)).toBeLessThanOrEqual(FADE_MAX_ENTRY_PRICE * 1e6);
    // pooled claim 0.536 minus year-spread + uncalibrated penalties -> conservative < 0.5
    expect(d.conservativeProbability6).not.toBeNull();
    expect(d.conservativeProbability6! < prob("0.50")).toBe(true);
    const warn = d.checks.find((c) => c.name === "stability_warning_2024")!;
    expect(warn.value).toContain("51.6");
    expect(d.checks.find((c) => c.name === "adverse_selection_unproven")).toBeDefined();
    expect(d.checks.find((c) => c.name === "research_only_not_live")!.requirement).toContain("presetAllowsMode");
  });

  it("fades a qualifying DOWN run with an UP candidate", () => {
    const f = featuresFor(64000, 64000, "0.48", "0.50");
    const d = preset.evaluate(f, ctxWith({ priorRun: { blocks: 5, direction: "DOWN", cumulativeMovePct: -1.4 } }));
    expect(d.side).toBe("UP");
    expect(d.candidate).toBe(true);
    expect(d.desiredMakerPrice6).toBe(prob("0.49")); // up bid 0.48 + one tick, under both ask and cap
  });

  it("produces no candidate when the engine supplies no prior-run state", () => {
    const f = featuresFor(64000, 64000);
    const d = preset.evaluate(f, ctxWith(undefined));
    expect(d.candidate).toBe(false);
    expect(d.side).toBeNull();
    expect(d.estimate ?? null).toBeNull();
    expect(d.checks.find((c) => c.name === "prior_run_available")!.pass).toBe(false);
  });

  it("rejects runs shorter than 4 blocks", () => {
    const f = featuresFor(64000, 64000);
    const d = preset.evaluate(f, ctxWith({ priorRun: { blocks: 3, direction: "UP", cumulativeMovePct: 2.0 } }));
    expect(d.candidate).toBe(false);
    expect(d.checks.find((c) => c.name === "run_length")!.pass).toBe(false);
  });

  it("an unknown run magnitude never passes (no fabrication)", () => {
    const f = featuresFor(64000, 64000);
    const d = preset.evaluate(f, ctxWith({ priorRun: { blocks: 4, direction: "UP", cumulativeMovePct: null } }));
    expect(d.candidate).toBe(false);
    const mag = d.checks.find((c) => c.name === "run_magnitude")!;
    expect(mag.pass).toBe(false);
    expect(mag.value).toBe("unknown");
  });

  it("rejects entries after the first 60 seconds of the window", () => {
    const lateMarket: MarketRef = { ...market, startEpoch: Math.floor(T0 / 1000) - 210, endEpoch: Math.floor(T0 / 1000) + 90 };
    const f = featuresFor(64000, 64000, "0.50", "0.52", lateMarket);
    const d = preset.evaluate(f, ctxWith({ priorRun: RUN_UP }));
    expect(d.candidate).toBe(false);
    expect(d.checks.find((c) => c.name === "entry_window")!.pass).toBe(false);
  });

  it("never pays above the 0.50 claim price even when the market already prices the reversal", () => {
    // up 0.38/0.40 -> down book bid 0.60 / ask 0.62: fade side is expensive
    const f = featuresFor(64000, 64000, "0.38", "0.40");
    const d = preset.evaluate(f, ctxWith({ priorRun: RUN_UP }));
    expect(d.side).toBe("DOWN");
    expect(d.desiredMakerPrice6).toBe(prob("0.50")); // capped at the claim price, not bid+tick=0.61
  });
});

describe("extended_move_fade_v1 can never emit a live-approved estimate", () => {
  it("estimates are hard-coded approvedForLive:false with a conservative band straddling 0.50", () => {
    const f = featuresFor(64000, 64000);
    for (const side of ["UP", "DOWN"] as const) {
      const est = extendedMoveFadeEstimate(f, side, RUN_UP);
      expect(est.approvedForLive).toBe(false);
      expect(est.modelVersion).toContain("UNCALIBRATED");
      expect(est.uncertainty).toBeGreaterThanOrEqual(0.065);
      const pSide = side === "UP" ? Number(est.probability) : 1e6 - Number(est.probability);
      const lowerSide = side === "UP" ? Number(est.lowerBound) : 1e6 - Number(est.upperBound);
      expect(pSide / 1e6).toBeCloseTo(FADE_POOLED_REVERSAL_RATE, 6);
      expect(lowerSide).toBeLessThan(500_000); // conservative bound below the coin flip
    }
  });

  it("a forged context cannot loosen the brief's floors or flip live approval", () => {
    const f = featuresFor(64000, 64000, "0.38", "0.40"); // fade-side (DOWN) book at 0.60/0.62
    const forged = {
      ...ctxWith(),
      probabilityModelKey: "calibrated_logistic", // fade preset must ignore this
      extendedMoveFade: {
        minRunBlocks: 0,            // below the brief floor -> clamped to 4
        minRunMovePct: 0,           // clamped to 0.8
        maxEntryPrice: 0.97,        // above the 0.50 claim -> clamped to 0.50
        entrySecondsRemainingMin: 0, // clamped to 240
        approvedForLive: true,       // junk field, must be inert
        priorRun: { blocks: 8, direction: "UP", cumulativeMovePct: 3.2 },
      },
    } as unknown as PresetContext;
    const d = preset.evaluate(f, forged);
    expect(d.side).toBe("DOWN");
    expect(d.desiredMakerPrice6).toBe(prob("0.50")); // forged 0.97 cap was clamped to the claim price
    expect(d.estimate).not.toBeNull();
    expect(d.estimate!.approvedForLive).toBe(false);
    expect(d.estimate!.modelVersion).toContain("UNCALIBRATED");
    expect(d.conservativeProbability6! < prob("0.50")).toBe(true);

    // and a forged short run is still rejected despite minRunBlocks: 0
    const forgedShort = {
      ...forged,
      extendedMoveFade: { ...(forged as { extendedMoveFade: object }).extendedMoveFade, priorRun: { blocks: 2, direction: "UP", cumulativeMovePct: 3.2 } },
    } as unknown as PresetContext;
    const d2 = preset.evaluate(f, forgedShort);
    expect(d2.candidate).toBe(false);
    expect(d2.checks.find((c) => c.name === "run_length")!.pass).toBe(false);
  });

  it("encodes the cited yearly rates verbatim, including the weak 2024 row", () => {
    expect(FADE_CLAIMED_REVERSAL_RATE_BY_YEAR[2023]).toBe(0.538);
    expect(FADE_CLAIMED_REVERSAL_RATE_BY_YEAR[2024]).toBe(0.516);
    expect(FADE_CLAIMED_REVERSAL_RATE_BY_YEAR[2025]).toBe(0.545);
    expect(FADE_CLAIMED_REVERSAL_RATE_BY_YEAR[2026]).toBe(0.546);
    expect(FADE_WEAKEST_YEAR_RATE).toBe(0.516);
    expect(FADE_MIN_RUN_BLOCKS).toBe(4);
    expect(FADE_MIN_RUN_MOVE_PCT).toBe(0.8);
    const pooled = (0.538 + 0.516 + 0.545 + 0.546) / 4;
    expect(FADE_POOLED_REVERSAL_RATE).toBeCloseTo(pooled, 3);
  });
});

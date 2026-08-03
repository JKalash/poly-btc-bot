import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type DbHandle } from "@b5p/db";
import type { ReferenceTick } from "@b5p/domain";
import type { ParsedFiveMinMarket } from "@b5p/polymarket";
import { getLocalBus } from "../src/bus";
import { Engine, computePriorRun } from "../src/engine";

/**
 * extended_move_fade_v1 inputs: the engine must supply the RESOLVED
 * prior-window run (consecutive same-direction resolved 5m windows +
 * cumulative move %) through PresetContext.extendedMoveFade.priorRun —
 * never inferred from the current window, never fabricated when boundary
 * data is missing.
 */

const W = 300;

function win(startEpoch: number, outcome: "UP" | "DOWN" | null, openText: string | null, closeText: string | null) {
  return { startEpoch, endEpoch: startEpoch + W, outcome, openText, closeText };
}

describe("computePriorRun (pure)", () => {
  const active = 1_785_500_100 - (1_785_500_100 % W);

  it("counts consecutive same-direction resolved windows and signs the cumulative move", () => {
    const run = computePriorRun([
      win(active - 4 * W, "UP", "64000", "64200"),
      win(active - 3 * W, "UP", "64200", "64350"),
      win(active - 2 * W, "UP", "64350", "64500"),
      win(active - 1 * W, "UP", "64500", "64700"),
    ], active)!;
    expect(run.blocks).toBe(4);
    expect(run.direction).toBe("UP");
    // (64700 - 64000) / 64000 * 100 = +1.09375%
    expect(run.cumulativeMovePct).toBeCloseTo(1.09375, 10);
  });

  it("a direction flip breaks the run at the flip", () => {
    const run = computePriorRun([
      win(active - 3 * W, "UP", "64500", "64300"),   // ignored: wrong direction
      win(active - 2 * W, "DOWN", "64300", "64100"),
      win(active - 1 * W, "DOWN", "64100", "63900"),
    ], active)!;
    expect(run.blocks).toBe(2);
    expect(run.direction).toBe("DOWN");
    expect(run.cumulativeMovePct).toBeCloseTo(((63900 - 64300) / 64300) * 100, 10);
  });

  it("an unresolved prior window means NO run (never inferred)", () => {
    expect(computePriorRun([win(active - W, null, "64000", "64100")], active)).toBeNull();
    expect(computePriorRun([], active)).toBeNull();
    // a gap (no window ending at the active start) also yields null
    expect(computePriorRun([win(active - 2 * W, "UP", "64000", "64100")], active)).toBeNull();
  });

  it("missing boundary values leave cumulativeMovePct null — fail-closed, never fabricated", () => {
    const run = computePriorRun([
      win(active - 2 * W, "UP", null, "64350"), // oldest open unknown
      win(active - 1 * W, "UP", "64350", "64500"),
    ], active)!;
    expect(run.blocks).toBe(2);
    expect(run.cumulativeMovePct).toBeNull();
  });
});

describe("engine supplies the prior run to extended_move_fade_v1", () => {
  const startEpoch = Math.floor(1_785_500_100 / W) * W;
  const endEpoch = startEpoch + W;
  const NOW0 = (startEpoch + 45) * 1000; // 255s remaining: inside the fade entry window (>=240s)

  let db: DbHandle;
  let engine: Engine;

  function market(overrides: Partial<ParsedFiveMinMarket>): ParsedFiveMinMarket {
    return {
      eventId: "ev1", marketId: "m1", conditionId: "0xcond", slug: `btc-updown-5m-${startEpoch}`,
      question: "BTC up or down", description: "Resolves Up if... Chainlink ... BTC/USD data stream",
      resolutionSource: "https://data.chain.link/streams/btc-usd",
      startEpoch, endEpoch, upTokenId: "tok-up", downTokenId: "tok-down",
      tickSize: 0.01, minOrderSize: 5, negRisk: false,
      active: true, closed: false, acceptingOrders: true,
      bestBid: 0.55, bestAsk: 0.56, volumeUsd: 50_000, outcomePrices: null,
      feeSchedule: { rate: 0.07, takerOnly: true, rebateRate: 0.2, feeType: "crypto_fees_v2" },
      rulesNameChainlink: true, raw: {} as ParsedFiveMinMarket["raw"],
      ...overrides,
    };
  }

  function tick(tsMs: number, value: number): ReferenceTick {
    return { source: "chainlink", symbol: "btc/usd", value, sourceTsMs: tsMs, receivedTsMs: tsMs + 30 };
  }

  beforeEach(async () => {
    db = await makeDb({ pgliteDir: "memory://", databaseUrl: undefined });
    await db.migrate();
    engine = new Engine(db, getLocalBus(), "paper");
    await engine.start(NOW0 - 1000);
    engine.cfg.strategy.active_version = "extended_move_fade_v1";
    // active market + four resolved prior windows chained back from its start
    const markets: ParsedFiveMinMarket[] = [market({})];
    for (let k = 1; k <= 4; k++) {
      markets.push(market({
        marketId: `p${k}`, eventId: `evp${k}`, slug: `btc-updown-5m-${startEpoch - k * W}`,
        startEpoch: startEpoch - k * W, endEpoch: startEpoch - (k - 1) * W,
        upTokenId: `pu${k}`, downTokenId: `pd${k}`,
      }));
    }
    await engine.upsertDiscoveredMarkets(markets, NOW0 - 1000);
    // resolve the priors: 4 consecutive UP windows, +1.09% cumulative
    const opens = ["64000", "64200", "64350", "64500"]; // oldest (p4) .. newest (p1)
    const closes = ["64200", "64350", "64500", "64700"];
    for (let k = 1; k <= 4; k++) {
      const rt = engine.markets.get(`p${k}`)!;
      rt.localOutcome = "UP";
      rt.priceToBeat = { text: opens[4 - k]!, float: Number(opens[4 - k]), capturedAtMs: NOW0 - 1000, source: "rtds_chainlink_boundary" };
      rt.finalValueText = closes[4 - k]!;
    }
  });

  afterEach(async () => {
    engine.stop();
    await db.close();
  });

  it("presetCtx.extendedMoveFade.priorRun reaches the preset gates with sane data", async () => {
    // warm world: 260s of chainlink history + fresh books
    for (let s = 260; s > 0; s--) {
      const ts = NOW0 - s * 1000;
      engine.onReferenceTick(tick(ts, (ts <= startEpoch * 1000 ? 64_700 : 64_710) + Math.sin(s)));
    }
    for (let i = 0; i < 10; i++) engine.onClockSample(10 + i);
    engine.onBookSnapshot("tok-up",
      [{ price: "0.55", size: "500" }, { price: "0.50", size: "800" }],
      [{ price: "0.56", size: "400" }, { price: "0.60", size: "700" }],
      NOW0 - 200, NOW0 - 200);
    engine.onBookSnapshot("tok-down",
      [{ price: "0.44", size: "450" }], [{ price: "0.45", size: "350" }],
      NOW0 - 200, NOW0 - 200);

    await engine.step(NOW0);
    const rt = engine.markets.get("m1")!;
    const gate = rt.lastEval?.gate;
    expect(gate).toBeTruthy();
    const check = (name: string) => gate!.checks.find((c) => c.name === name)!;
    expect(check("prior_run_available").pass).toBe(true);
    expect(check("prior_run_available").value).toContain("4 blocks");
    expect(check("run_length").pass).toBe(true);
    expect(check("run_magnitude").pass).toBe(true); // 1.09% >= 0.8%
    expect(check("run_magnitude").value).toContain("1.09");
    expect(gate!.side).toBe("DOWN"); // fade opposes the UP run
    // the estimate carries the engine-supplied run in its attributions
    expect(gate!.estimate?.featureAttributions?.priorRunBlocks).toBe(4);
  });

  it("with an unresolved prior chain the preset fails closed (no candidate)", async () => {
    for (let k = 1; k <= 4; k++) {
      engine.markets.get(`p${k}`)!.localOutcome = null;
      engine.markets.get(`p${k}`)!.officialOutcome = null;
    }
    for (let s = 260; s > 0; s--) engine.onReferenceTick(tick(NOW0 - s * 1000, 64_700));
    engine.onBookSnapshot("tok-up", [{ price: "0.55", size: "500" }], [{ price: "0.56", size: "400" }], NOW0 - 200, NOW0 - 200);
    engine.onBookSnapshot("tok-down", [{ price: "0.44", size: "450" }], [{ price: "0.45", size: "350" }], NOW0 - 200, NOW0 - 200);
    await engine.step(NOW0);
    const gate = engine.markets.get("m1")!.lastEval?.gate;
    expect(gate).toBeTruthy();
    expect(gate!.checks.find((c) => c.name === "prior_run_available")!.pass).toBe(false);
    expect(gate!.candidate).toBe(false);
  });
});

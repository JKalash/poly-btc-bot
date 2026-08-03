import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@b5p/config";
import { ctfOperations, makeDb, pairedLegs, pairedQuoteCycles, type DbHandle } from "@b5p/db";
import { isRiskFree, mulDiv, takerFeeUsdc, usdc, type ReferenceTick } from "@b5p/domain";
import type { ParsedFiveMinMarket } from "@b5p/polymarket";
import { BookState } from "@b5p/strategy";
import { LiquidityRewardLedger, RebateLedger } from "../src/accruals";
import { getLocalBus } from "../src/bus";
import { Engine } from "../src/engine";
import {
  DEFAULT_INVENTORY_RESEARCH, DisabledLiveMarketMakingAdapter, LIVE_MM_REFUSAL,
  PairedCycleSimulator, decideHedgeOrCancel, resolveInventoryResearchConfig,
  type CycleMarketCtx, type CycleRiskRejection, type ResolvedInventoryResearchConfig,
} from "../src/inventory-cycle";
import { MemoryInventorySink } from "../src/inventory-persistence";

/**
 * Phase 3 (R10): paired-cycle inventory/CTF simulation — PAPER/SHADOW ONLY.
 *
 * Coverage required by the plan:
 *  - full state-machine paths incl. ONE_LEG_FILLED -> hedge and -> cancel;
 *  - a cycle with an open leg is NEVER counted risk-free anywhere;
 *  - split/merge/redeem gas + taker fees accounted in cycle P&L (exact bigint);
 *  - unpaid accruals never realized, never in pre-trade EV;
 *  - determinism per seed (correlationId-keyed RNG, fixed cadence);
 *  - simulator OFF by default and unreachable in live mode.
 */

const NOW = 1_785_500_000_000;
const END_EPOCH = Math.floor(NOW / 1000) + 240;
const END_MS = END_EPOCH * 1000;
const CUTOFF_MS = END_MS - 45_000;
const PAIR = usdc("10"); // 10 paired shares (µshares)

function book(tokenId: string, bids: Array<[string, string]>, asks: Array<[string, string]>): BookState {
  const b = new BookState(tokenId);
  b.applySnapshot(
    bids.map(([price, size]) => ({ price, size })),
    asks.map(([price, size]) => ({ price, size })),
    NOW - 100, NOW - 100,
  );
  return b;
}

/** up ask 0.53 / down ask 0.50 => split-sell edge 0.03 (buy edge only 0.01). */
function splitSellBooks(): Map<string, BookState> {
  return new Map([
    ["tu", book("tu", [["0.50", "500"]], [["0.53", "400"]])],
    ["td", book("td", [["0.49", "450"]], [["0.50", "350"]])],
  ]);
}

/** up bid 0.49 / down bid 0.47 => buy-both edge 0.04 (sell edge only 0.02). */
function buyBothBooks(): Map<string, BookState> {
  return new Map([
    ["tu", book("tu", [["0.49", "500"]], [["0.52", "400"]])],
    ["td", book("td", [["0.47", "450"]], [["0.50", "350"]])],
  ]);
}

function ctx(): CycleMarketCtx {
  return {
    marketId: "m1", conditionId: "0xcond", slug: "btc-updown-5m-test",
    upTokenId: "tu", downTokenId: "td",
    endEpoch: END_EPOCH, cutoffMs: CUTOFF_MS,
    tickSize6: 10_000n, feeRatePpm: 70_000n, rebateSharePpm: 200_000n,
    maxBookAgeMs: 10_000,
  };
}

interface Rig {
  sim: PairedCycleSimulator;
  sink: MemoryInventorySink;
  rebates: RebateLedger;
  rewards: LiquidityRewardLedger;
  rejections: CycleRiskRejection[];
}

function rig(args: {
  mode?: "paper" | "shadow";
  books?: Map<string, BookState>;
  cfg?: Partial<ResolvedInventoryResearchConfig>;
  bankroll?: bigint;
} = {}): Rig {
  const sink = new MemoryInventorySink();
  const rebates = new RebateLedger((e) => sink.upsertRebate(e), () => 1);
  const rewards = new LiquidityRewardLedger((e) => sink.upsertReward(e), () => 1);
  const books = args.books ?? splitSellBooks();
  const cfg: ResolvedInventoryResearchConfig = {
    ...DEFAULT_INVENTORY_RESEARCH,
    enabled: true,
    splitFailureFraction: 0,
    quoteFillHazardPerSec: 0,
    splitLatencyMs: 1000,
    mergeLatencyMs: 1000,
    clamped: [],
    ...(args.cfg ?? {}),
  };
  const rejections: CycleRiskRejection[] = [];
  let seq = 0;
  const sim = new PairedCycleSimulator({
    mode: args.mode ?? "paper",
    sink,
    books: (tokenId) => books.get(tokenId) ?? null,
    cfg: () => cfg,
    configVersion: () => 1,
    rebates,
    rewards,
    bankroll6: () => args.bankroll ?? usdc("2000"),
    onRiskRejection: (r) => rejections.push(r),
    idFactory: () => `id-${++seq}`,
  });
  return { sim, sink, rebates, rewards, rejections };
}

function states(r: Rig, id: string): string[] {
  return r.sim.cycleView(id)!.history.map((h) => h.state);
}

// ---------------------------------------------------------------------------

describe("mode guard: paper/shadow only, live hard-unreachable", () => {
  it("constructor refuses any mode but paper/shadow", () => {
    const base = rig(); // proves paper constructs
    expect(base.sim.execMode).toBe("PAPER");
    expect(rig({ mode: "shadow" }).sim.execMode).toBe("SHADOW");
    for (const mode of ["live", "observe", "LIVE", ""]) {
      expect(() =>
        new PairedCycleSimulator({
          mode: mode as never,
          sink: new MemoryInventorySink(),
          books: () => null,
          cfg: () => ({ ...DEFAULT_INVENTORY_RESEARCH, clamped: [] }),
          configVersion: () => 1,
          rebates: new RebateLedger(null, () => 1),
          rewards: new LiquidityRewardLedger(null, () => 1),
        }),
      ).toThrow(/PAPER\/SHADOW-ONLY/);
    }
  });

  it("the only live MM surface is a disabled stub that hard-refuses every call", async () => {
    const adapter = new DisabledLiveMarketMakingAdapter();
    for (const call of [
      adapter.submitQuote(), adapter.cancelQuote(), adapter.splitCollateral(),
      adapter.mergePairs(), adapter.redeemPositions(),
    ]) {
      const res = await call;
      expect(res.accepted).toBe(false);
      expect(res.reason).toBe(LIVE_MM_REFUSAL);
      expect(res.reason).toContain("DISABLED");
    }
  });

  it("config resolver: OFF by default and unsafe keys clamped", () => {
    const def = resolveInventoryResearchConfig(DEFAULT_CONFIG);
    expect(def.enabled).toBe(false); // OFF by default
    expect(def.liveAllowed).toBe(false);
    expect(def.rebatesInPretradeEv).toBe(false);
    const hostile = resolveInventoryResearchConfig({
      ...DEFAULT_CONFIG,
      inventory_research: {
        enabled: true, live_allowed: true, rebates_in_pretrade_ev: true, rewards_in_pretrade_ev: true,
      },
    } as never);
    expect(hostile.enabled).toBe(true);
    expect(hostile.liveAllowed).toBe(false); // clamped
    expect(hostile.rebatesInPretradeEv).toBe(false); // clamped
    expect(hostile.rewardsInPretradeEv).toBe(false); // clamped
    expect(hostile.clamped.sort()).toEqual(["live_allowed", "rebates_in_pretrade_ev", "rewards_in_pretrade_ev"]);
  });

  it("consider() is a no-op while disabled", () => {
    const r = rig({ cfg: { enabled: false } });
    expect(r.sim.consider(ctx(), NOW)).toBeNull();
    expect(r.sim.cycles().length).toBe(0);
  });
});

describe("SPLIT_SELL happy path (both legs fill as maker)", () => {
  it("walks the R10 main path with exact split-gas-inclusive P&L", () => {
    const r = rig();
    const id = r.sim.consider(ctx(), NOW, "seed-split-happy")!;
    expect(id).toBeTruthy();
    expect(r.sim.cycleView(id)!.riskFree).toBe(false); // PLANNED is not risk-free

    r.sim.step(NOW); // PLANNED -> INVENTORY_PREFLIGHT -> SPLIT_PENDING
    expect(r.sim.cycleView(id)!.row.state).toBe("SPLIT_PENDING");
    r.sim.step(NOW + 1100); // split confirms -> INVENTORY_READY -> QUOTING_BOTH
    expect(r.sim.cycleView(id)!.row.state).toBe("QUOTING_BOTH");
    expect(r.sim.cycleView(id)!.riskFree).toBe(false); // resting quotes are open legs

    expect(r.sim.simulateLegFill(id, 0, NOW + 2000)).toBe(true); // UP sold 0.53
    expect(r.sim.cycleView(id)!.row.state).toBe("ONE_LEG_FILLED");
    expect(r.sim.cycleView(id)!.riskFree).toBe(false); // directional exposure

    expect(r.sim.simulateLegFill(id, 1, NOW + 2100)).toBe(true); // DOWN sold 0.50
    const v = r.sim.cycleView(id)!;
    expect(v.row.state).toBe("RECONCILED");
    expect(states(r, id)).toEqual([
      "PLANNED", "INVENTORY_PREFLIGHT", "SPLIT_PENDING", "INVENTORY_READY", "QUOTING_BOTH",
      "ONE_LEG_FILLED", "BOTH_LEGS_FILLED", "MERGE_OR_SETTLE", "REWARD_PENDING", "RECONCILED",
    ]);
    // P&L: proceeds 5.30 + 5.00, outlay 10.00 collateral, split gas 0.02
    expect(v.row.spreadCaptured6).toBe(usdc("0.30"));
    expect(v.row.fees6).toBe(0n); // both fills maker
    expect(v.row.realizedPnl6).toBe(usdc("0.28")); // 0.30 spread - 0.02 gas
    expect(v.riskFree).toBe(true); // earned ONLY here
    // split op persisted with gas; legs closed
    const split = [...r.sink.ctfOps.values()].find((o) => o.kind === "SPLIT")!;
    expect(split.state).toBe("CONFIRMED");
    expect(split.actualGasUsdc6).toBe(usdc("0.02"));
    expect(v.legs.every((l) => l.state === "HEDGED")).toBe(true);
    // rebates: ACCRUED -> PENDING at reconcile; NEVER paid by the simulator
    for (const leg of [0, 1] as const) void leg;
    const rebateStates = [...r.sink.rebates.values()].map((e) => e.state).sort();
    expect(rebateStates).toEqual(["PENDING", "PENDING"]);
    expect(r.rebates.realizedTotal6()).toBe(0n);
  });
});

describe("ONE_LEG_FILLED -> HEDGE branch", () => {
  it("dumps the survivor as taker with decay + fee accounted, then reconciles", () => {
    const r = rig({ cfg: { hedgePolicy: "hedge" } });
    const id = r.sim.consider(ctx(), NOW, "seed-hedge")!;
    r.sim.step(NOW);
    r.sim.step(NOW + 1100); // QUOTING_BOTH
    r.sim.simulateLegFill(id, 0, NOW + 2000); // UP sold; DOWN survivor held
    expect(r.sim.cycleView(id)!.riskFree).toBe(false);

    r.sim.step(NOW + 4500); // unhedged 2500ms >= 2000ms budget -> HEDGE_OR_CANCEL -> hedge
    const v = r.sim.cycleView(id)!;
    expect(states(r, id)).toContain("HEDGE_OR_CANCEL");
    expect(v.row.state).toBe("RECONCILED");
    expect(v.row.unhedgedDurationMs).toBe(2500);
    expect(v.row.hedgeCompletedAtMs).toBe(NOW + 4500);

    // survivor DOWN dumped at bid 0.49 decayed by ceil(0.49 * round(5bps*2.5s)/1e4) = 637µ
    const hedgePrice6 = 490_000n - 637n;
    const fee6 = takerFeeUsdc(PAIR, hedgePrice6, 70_000n);
    expect(fee6 > 0n).toBe(true);
    const hedge = r.sink.hedges.values().next().value!;
    expect(hedge.kind).toBe("DUMP_SURVIVOR_TAKER");
    expect(hedge.state).toBe("DONE");
    expect(hedge.feeUsdc6).toBe(fee6);
    expect(hedge.unhedgedDurationMs).toBe(2500);

    const proceeds6 = usdc("5.30") + mulDiv(PAIR, hedgePrice6, 1_000_000n, "floor");
    expect(v.row.fees6).toBe(fee6);
    expect(v.row.realizedPnl6).toBe(proceeds6 - usdc("10") - fee6 - usdc("0.02"));
    expect(v.legs.every((l) => l.state === "HEDGED")).toBe(true);
    // taker hedge earns no rebate: survivor leg's expectation voided
    const rebateStates = [...r.sink.rebates.values()].map((e) => e.state).sort();
    expect(rebateStates).toEqual(["DISPUTED", "PENDING"]);
    expect(v.riskFree).toBe(true);
  });
});

describe("ONE_LEG_FILLED -> CANCEL branch (hold to settlement)", () => {
  function runToCancel(): Rig & { id: string } {
    const r = rig({ cfg: { hedgePolicy: "cancel" } });
    const id = r.sim.consider(ctx(), NOW, "seed-cancel")!;
    r.sim.step(NOW);
    r.sim.step(NOW + 1100);
    r.sim.simulateLegFill(id, 0, NOW + 2000); // UP sold; hold DOWN exposure
    r.sim.step(NOW + 4500); // budget exceeded -> HEDGE_OR_CANCEL -> cancel + hold
    return { ...r, id };
  }

  it("cancels the resting quote, records CANCEL + HOLD hedge actions, stays exposed (never risk-free)", () => {
    const r = runToCancel();
    const v = r.sim.cycleView(r.id)!;
    expect(v.row.state).toBe("MERGE_OR_SETTLE");
    const kinds = [...r.sink.hedges.values()].map((h) => h.kind).sort();
    expect(kinds).toEqual(["CANCEL_REMAINING_QUOTE", "HOLD_TO_RESOLUTION"]);
    expect(v.legs.map((l) => l.state).sort()).toEqual(["CANCELED", "UNHEDGED"]);
    expect(v.riskFree).toBe(false); // open exposure held to settlement
    expect(r.sim.summary().riskFreeCycles).toBe(0);
    expect(r.sim.summary().oneLegOpen).toBe(1);
  });

  it("settles a WINNING survivor at resolution: redeem 1.00 minus redeem gas, exact P&L", () => {
    const r = runToCancel();
    r.sim.onResolution("m1", "DOWN", END_MS + 100); // held DOWN wins
    const v = r.sim.cycleView(r.id)!;
    expect(v.row.state).toBe("RECONCILED");
    // proceeds 5.30 (UP sale) + 10.00 (redeem); gas split 0.02 + redeem 0.02
    expect(v.row.realizedPnl6).toBe(usdc("15.30") - usdc("10") - usdc("0.04"));
    const redeem = [...r.sink.ctfOps.values()].find((o) => o.kind === "REDEEM")!;
    expect(redeem.state).toBe("CONFIRMED");
    expect(v.legs.map((l) => l.state).sort()).toEqual(["CANCELED", "SETTLED"]);
    expect(v.riskFree).toBe(true);
  });

  it("settles a LOSING survivor at zero and books the loss toward the operational stop", () => {
    const r = runToCancel();
    r.sim.onResolution("m1", "UP", END_MS + 100); // held DOWN loses
    const v = r.sim.cycleView(r.id)!;
    expect(v.row.state).toBe("RECONCILED");
    expect(v.row.realizedPnl6).toBe(usdc("5.30") - usdc("10") - usdc("0.02")); // -4.72
    expect(r.sim.summary().operationalLoss6).toBe(usdc("4.72"));
    expect([...r.sink.ctfOps.values()].some((o) => o.kind === "REDEEM")).toBe(false); // nothing fabricated
  });
});

describe("BUY_BOTH_MERGE path", () => {
  it("buys both legs as maker, merges to 1.00 with merge gas in P&L", () => {
    const r = rig({ books: buyBothBooks() });
    const id = r.sim.consider(ctx(), NOW, "seed-buyboth")!;
    r.sim.step(NOW); // no split needed -> QUOTING_BOTH
    expect(r.sim.cycleView(id)!.row.state).toBe("QUOTING_BOTH");
    expect(r.sim.cycleView(id)!.row.kind).toBe("BUY_BOTH_MERGE");
    r.sim.simulateLegFill(id, 0, NOW + 1000); // buy UP 0.49
    r.sim.simulateLegFill(id, 1, NOW + 1500); // buy DOWN 0.47 -> merge submitted
    expect(r.sim.cycleView(id)!.row.state).toBe("MERGE_PENDING");
    expect(r.sim.cycleView(id)!.riskFree).toBe(false); // merge not reconciled yet
    r.sim.step(NOW + 2600); // merge confirms
    const v = r.sim.cycleView(id)!;
    expect(v.row.state).toBe("RECONCILED");
    expect(states(r, id)).toEqual([
      "PLANNED", "INVENTORY_PREFLIGHT", "INVENTORY_READY", "QUOTING_BOTH",
      "ONE_LEG_FILLED", "BOTH_LEGS_FILLED", "MERGE_OR_SETTLE", "MERGE_PENDING",
      "REWARD_PENDING", "RECONCILED",
    ]);
    // merge returns 10.00; cost 4.90 + 4.70; merge gas 0.02
    expect(v.row.realizedPnl6).toBe(usdc("10") - usdc("9.60") - usdc("0.02"));
    const merge = [...r.sink.ctfOps.values()].find((o) => o.kind === "MERGE")!;
    expect(merge.state).toBe("CONFIRMED");
    expect(merge.actualGasUsdc6).toBe(usdc("0.02"));
    expect(v.riskFree).toBe(true);
  });
});

describe("cutoff with zero fills: clean abort, merge-back, gas-only loss", () => {
  it("cancels quotes, merges the untouched pair back, P&L = -(split+merge gas)", () => {
    const r = rig();
    const id = r.sim.consider(ctx(), NOW, "seed-cutoff")!;
    r.sim.step(NOW);
    r.sim.step(NOW + 1100); // QUOTING_BOTH
    r.sim.step(CUTOFF_MS); // cutoff -> cancel -> INVENTORY_READY -> MERGE_PENDING
    expect(r.sim.cycleView(id)!.row.state).toBe("MERGE_PENDING");
    r.sim.step(CUTOFF_MS + 1100);
    const v = r.sim.cycleView(id)!;
    expect(v.row.state).toBe("RECONCILED");
    expect(v.row.realizedPnl6).toBe(-usdc("0.04")); // gas is never free
    expect(v.legs.every((l) => l.state === "CANCELED")).toBe(true);
    // unexecuted quote expectations are voided, not accrued
    const rebateStates = [...r.sink.rebates.values()].map((e) => e.state);
    expect(rebateStates).toEqual(["DISPUTED", "DISPUTED"]);
    // liquidity-reward uptime accrued (separate program) but realized 0
    const reward = [...r.sink.rewards.values()][0]!;
    expect(reward.state).toBe("ACCRUED");
    expect(reward.qualifyingUptimeMs).toBe(CUTOFF_MS - (NOW + 1100));
    expect(r.rewards.realizedTotal6()).toBe(0n);
    expect(r.sim.summary().realizedRewards6).toBe(0n);
  });
});

describe("open leg is NEVER risk-free (isRiskFree is the only counter)", () => {
  it("riskFree stays false through every in-flight state and summary never counts open cycles", () => {
    const r = rig({ cfg: { hedgePolicy: "cancel" } });
    const id = r.sim.consider(ctx(), NOW, "seed-riskfree")!;
    const observed: Array<[string, boolean]> = [];
    const note = () => {
      const v = r.sim.cycleView(id)!;
      observed.push([v.row.state, v.riskFree]);
    };
    note();
    r.sim.step(NOW); note();
    r.sim.step(NOW + 1100); note();
    r.sim.simulateLegFill(id, 0, NOW + 2000); note();
    r.sim.step(NOW + 4500); note(); // cancel branch -> MERGE_OR_SETTLE, exposure open
    for (const [state, riskFree] of observed) {
      expect(riskFree, `state ${state} must not be risk-free`).toBe(false);
    }
    expect(r.sim.summary().riskFreeCycles).toBe(0);
    // domain predicate agrees directly: RECONCILED alone is not enough with an open leg
    const v = r.sim.cycleView(id)!;
    expect(isRiskFree({ state: "RECONCILED" }, v.legs)).toBe(false); // UNHEDGED leg present
    r.sim.onResolution("m1", "DOWN", END_MS + 100);
    expect(r.sim.cycleView(id)!.riskFree).toBe(true); // earned only after settle+reconcile
    expect(r.sim.summary().riskFreeCycles).toBe(1);
  });
});

describe("hedge-or-cancel decision rule (pure)", () => {
  const base = {
    kind: "SPLIT_SELL" as const,
    exposureShares6: PAIR,
    siblingQuote6: 500_000n,
    takerFeeRatePpm: 70_000n,
  };

  it("auto hedges within budget, cancels beyond it, and cancels with no liquidity", () => {
    const cheap = decideHedgeOrCancel({ ...base, policy: "auto", executableNow6: 495_000n, lossBudget6: usdc("1") });
    expect(cheap.action).toBe("HEDGE");
    expect(cheap.hedgeKind).toBe("DUMP_SURVIVOR_TAKER");
    const dear = decideHedgeOrCancel({ ...base, policy: "auto", executableNow6: 300_000n, lossBudget6: usdc("0.05") });
    expect(dear.action).toBe("CANCEL_AND_SETTLE");
    const dry = decideHedgeOrCancel({ ...base, policy: "hedge", executableNow6: null, lossBudget6: usdc("999") });
    expect(dry.action).toBe("CANCEL_AND_SETTLE"); // even policy=hedge cannot hedge into nothing
    const buyKind = decideHedgeOrCancel({ ...base, kind: "BUY_BOTH_MERGE", policy: "hedge", executableNow6: 520_000n, lossBudget6: 0n });
    expect(buyKind.hedgeKind).toBe("COMPLETE_PAIR_TAKER");
  });

  it("cost estimate = slippage vs plan + taker fee", () => {
    const d = decideHedgeOrCancel({ ...base, policy: "auto", executableNow6: 480_000n, lossBudget6: usdc("999") });
    const expected = mulDiv(PAIR, 20_000n, 1_000_000n, "ceil") + takerFeeUsdc(PAIR, 480_000n, 70_000n);
    expect(d.estimatedCost6).toBe(expected);
  });
});

describe("determinism per seed", () => {
  function run(): string {
    const r = rig({ cfg: { quoteFillHazardPerSec: 0.5, splitFailureFraction: 0.3 } });
    const id = r.sim.consider(ctx(), NOW, "det-seed-1")!;
    for (let t = NOW; t <= END_MS; t += 1000) r.sim.step(t);
    r.sim.onResolution("m1", "UP", END_MS + 100);
    const v = r.sim.cycleView(id)!;
    return JSON.stringify(
      { row: v.row, legs: v.legs, history: v.history, summary: r.sim.summary() },
      (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x),
    );
  }

  it("same correlationId + books + cadence => bit-identical cycles", () => {
    const a = run();
    const b = run();
    expect(a).toBe(b);
    expect(a).toContain("RECONCILED"); // the run actually terminates
  });

  it("different seeds may diverge, but both stay legal and reconciled", () => {
    const r1 = rig({ cfg: { quoteFillHazardPerSec: 0.5 } });
    const id1 = r1.sim.consider(ctx(), NOW, "det-seed-A")!;
    const r2 = rig({ cfg: { quoteFillHazardPerSec: 0.5 } });
    const id2 = r2.sim.consider(ctx(), NOW, "det-seed-B")!;
    for (let t = NOW; t <= END_MS; t += 1000) {
      r1.sim.step(t);
      r2.sim.step(t);
    }
    r1.sim.onResolution("m1", "UP", END_MS + 100);
    r2.sim.onResolution("m1", "UP", END_MS + 100);
    expect(r1.sim.cycleView(id1)!.row.state).toBe("RECONCILED");
    expect(r2.sim.cycleView(id2)!.row.state).toBe("RECONCILED");
  });
});

// ---------------------------------------------------------------------------
// Engine wiring: config-gated, OFF by default, paper/shadow only, persisted.
// ---------------------------------------------------------------------------

describe("engine wiring", () => {
  const startEpoch = Math.floor(1_785_500_100 / 300) * 300;
  const endEpoch = startEpoch + 300;
  const NOW0 = (endEpoch - 90) * 1000;

  let db: DbHandle;
  let engine: Engine;

  function market(): ParsedFiveMinMarket {
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
    };
  }

  function tick(tsMs: number, value: number, source: "chainlink" | "binance" = "chainlink"): ReferenceTick {
    return { source, symbol: source === "chainlink" ? "btc/usd" : "btcusdt", value, sourceTsMs: tsMs, receivedTsMs: tsMs + 30 };
  }

  async function warmWorld(nowMs: number): Promise<void> {
    for (let s = 260; s > 0; s--) {
      const ts = nowMs - s * 1000;
      const beforeBoundary = ts <= startEpoch * 1000;
      engine.onReferenceTick(tick(ts, (beforeBoundary ? 64_000 : 64_100) + 2 * Math.sin(s)));
    }
    for (let i = 0; i < 10; i++) engine.onClockSample(10 + i);
    const bookTs = nowMs - 200;
    engine.onBookSnapshot("tok-up",
      [{ price: "0.55", size: "500" }], [{ price: "0.56", size: "400" }], bookTs, bookTs);
    engine.onBookSnapshot("tok-down",
      [{ price: "0.44", size: "450" }], [{ price: "0.45", size: "350" }], bookTs, bookTs);
  }

  beforeEach(async () => {
    db = await makeDb({ pgliteDir: "memory://", databaseUrl: undefined });
    await db.migrate();
    engine = new Engine(db, getLocalBus(), "paper");
    await engine.start(NOW0 - 1000);
    await engine.upsertDiscoveredMarkets([market()], NOW0 - 1000);
  });

  afterEach(async () => {
    engine.stop();
    await db.close();
  });

  it("OFF by default: no cycles, no rows, even with a juicy pair edge", async () => {
    await warmWorld(NOW0);
    await engine.step(NOW0);
    await engine.step(NOW0 + 2500);
    expect(engine.inventorySim).not.toBeNull();
    expect(engine.inventorySim!.cycles().length).toBe(0);
    expect((await db.db.select().from(pairedQuoteCycles)).length).toBe(0);
  });

  it("observe mode never constructs the simulator", async () => {
    const db2 = await makeDb({ pgliteDir: "memory://", databaseUrl: undefined });
    await db2.migrate();
    const obs = new Engine(db2, getLocalBus(), "observe");
    expect(obs.inventorySim).toBeNull();
    obs.stop();
    await db2.close();
  });

  it("enabled via inventory_research config: plans a cycle and persists cycle/legs/ctf rows (FK order)", async () => {
    (engine.cfg as unknown as { inventory_research?: unknown }).inventory_research = {
      enabled: true,
      split_failure_fraction: "0",
      min_cycle_edge: "0.001",
    };
    // The unhedged budget lives ONLY in inventory_risk; the engine syncs the
    // simulator and the risk gate from there (single source of truth).
    (engine.cfg as unknown as { inventory_risk?: unknown }).inventory_risk = {
      max_unhedged_risk_fraction: "0.001",
    };
    await warmWorld(NOW0);
    await engine.step(NOW0); // plans + submits split
    await engine.step(NOW0 + 2500); // split confirms -> QUOTING_BOTH
    const cycles = await db.db.select().from(pairedQuoteCycles);
    expect(cycles.length).toBe(1);
    expect(cycles[0]!.mode).toBe("PAPER");
    expect(cycles[0]!.kind).toBe("SPLIT_SELL");
    expect(cycles[0]!.state).toBe("QUOTING_BOTH");
    const legs = await db.db.select().from(pairedLegs);
    expect(legs.length).toBe(2);
    expect(legs.every((l) => l.cycleId === cycles[0]!.id)).toBe(true);
    expect(legs.every((l) => l.state === "QUOTED")).toBe(true);
    const ops = await db.db.select().from(ctfOperations);
    expect(ops.length).toBe(1);
    expect(ops[0]!.kind).toBe("SPLIT");
    expect(ops[0]!.state).toBe("CONFIRMED");
    // cockpit surfaces the research block only when enabled
    const cockpit = engine.cockpitState(NOW0 + 2500) as { inventoryResearch: { openCycles: number } | null };
    expect(cockpit.inventoryResearch).not.toBeNull();
    expect(cockpit.inventoryResearch!.openCycles).toBe(1);
  });
});

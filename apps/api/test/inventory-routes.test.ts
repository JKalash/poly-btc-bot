import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  boundaryPriceObservations, ctfOperations, feedBasisEstimates, hedgeActions, inventorySnapshots,
  liquidityRewardAccruals, makeDb, pairedLegs, pairedQuoteCycles, rebateAccruals, type DbHandle,
} from "@b5p/db";
import { getLocalBus } from "@b5p/engine";
import { seedAll } from "@b5p/research";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { AuthService } from "../src/auth";
import { buildServer } from "../src/server";

/**
 * Inventory Lab read routes over the R10 paired-cycle simulation tables. The
 * simulator is paper/shadow only and OFF by default, so the empty shapes are
 * the common case and the dashboard's empty states depend on them. Seeded
 * assertions pin the two contracts that matter most:
 *  - riskFree is the domain isRiskFree predicate (RECONCILED + all legs
 *    closed) — a split position is not risk-free while a leg is open;
 *  - the two accrual ledgers stay strictly separate and realized income
 *    counts PAID rows only (paid_amount6, never the amount6 estimate).
 */

const CYCLE_STATES = [
  "PLANNED", "INVENTORY_PREFLIGHT", "SPLIT_PENDING", "INVENTORY_READY", "QUOTING_BOTH",
  "ONE_LEG_FILLED", "HEDGE_OR_CANCEL", "BOTH_LEGS_FILLED", "MERGE_OR_SETTLE", "RECONCILED",
  "ALLOWANCE_BLOCKED", "MERGE_PENDING", "REWARD_PENDING", "HALTED", "FAILED_RECONCILIATION",
] as const;
const LEG_STATES = ["PLANNED", "QUOTED", "PARTIAL_LEG", "UNHEDGED", "HEDGED", "CANCELED", "SETTLED"] as const;
const ACCRUAL_STATES = ["EXPECTED", "ACCRUED", "PENDING", "PAID", "DISPUTED"] as const;

const ROUTES = [
  "/api/inventory/cycles",
  "/api/inventory/summary",
  "/api/inventory/accruals",
  "/api/inventory/snapshots",
  "/api/inventory/basis",
];

interface CyclePayloadRow {
  id: string;
  state: string;
  worstCaseLoss6: string;
  unhedgedDurationMs: number | null;
  correlationId: string;
  riskFree: boolean;
  legs: Array<{ id: string; state: string; outcomeSide: string; correlationId: string }>;
  hedgeActions: Array<{ id: string; kind: string; state: string }>;
  ctfOperations: Array<{ id: string; kind: string; state: string; failureReason: string | null }>;
}
interface CyclesPayload { cycles: CyclePayloadRow[]; states: string[]; legStates: string[]; notes: string[]; note?: string }
interface SummaryPayload {
  cycles: { total: number; byState: Array<{ state: string; n: number }>; oneLegFilled: number; hedgeCompleted: number };
  legs: { byState: Array<{ state: string; n: number }> };
  hedges: { byKind: Array<{ kind: string; n: number; done: number; failed: number }> };
  operations: {
    byKind: Array<{ kind: string; n: number; confirmed: number; unknown: number; estGas6: string; actualGas6: string }>;
    unknownOutcomes: number; estGas6: string; actualGas6: string; recent: Array<{ id: string; state: string }>;
  };
  worstCaseLoss: { open: { n: number; sum6: string; max6: string }; all: { n: number; sum6: string; max6: string } };
  unhedged: { n: number; maxMs: number | null; avgMs: number | null; overCapCount: number; capMs: number };
  notes: string[];
  note?: string;
}
interface Ledger {
  program: string;
  byState: Array<{ state: string; n: number; amount6: string }>;
  realized: { n: number; paid6: string };
  unrealized: { n: number; amount6: string };
  inconsistentRows: number;
}
interface AccrualsPayload { makerRebate: Ledger; liquidityReward: Ledger; states: string[]; notes: string[]; note?: string }
interface SnapshotsPayload {
  snapshots: Array<{ id: string; reconciled: boolean; divergence: Record<string, unknown> | null }>;
  totals: { n: number; mismatches: number };
  note?: string;
}
interface BasisPayload {
  basis: { pairs: Array<{ symbol: string; estimates: number; meanPpmMin: number; meanPpmMax: number; latest: { meanPpm: number } }> };
  boundary: {
    byKind: Array<{ kind: string; n: number }>;
    totals: { n: number; matched: number; mismatched: number; unchecked: number; lateCaptures: number };
    recent: Array<{ id: string; firstAtOrAfterBoundary: boolean }>;
  };
  notes: string[];
  note?: string;
}

let db: DbHandle;
let app: FastifyInstance;
let cookie = "";

beforeAll(async () => {
  db = await makeDb({ pgliteDir: "memory://", databaseUrl: undefined });
  await db.migrate();
  await seedAll(db); // base seeds only — the inventory tables stay empty
  process.env.OPERATOR_PASSWORD_HASH = await AuthService.hashPassword("test-password-123");
  process.env.OPERATOR_USERNAME = "operator";
  const auth = new AuthService();
  await auth.ensurePasswordHash();
  app = await buildServer({ db, bus: getLocalBus(), auth, requireAuth: true });
  await app.ready();
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "operator", password: "test-password-123" } });
  const setCookies = res.headers["set-cookie"] as string[] | string;
  const all = Array.isArray(setCookies) ? setCookies : [setCookies];
  cookie = all.find((c) => c.startsWith("b5p_session="))!.split(";")[0]!;
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe("inventory lab routes (empty — the default, simulator off)", () => {
  it("every route is guarded", async () => {
    for (const url of ROUTES) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it("cycles: empty list, full state vocabularies, mandated risk language", async () => {
    const res = await app.inject({ method: "GET", url: "/api/inventory/cycles", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as CyclesPayload;
    expect(body.cycles).toEqual([]);
    expect(body.states).toEqual([...CYCLE_STATES]);
    expect(body.legStates).toEqual([...LEG_STATES]);
    expect(body.notes).toContain("A split position is not risk-free while a leg is open.");
    expect(body.notes).toContain("One-leg exposure is directional risk.");
  });

  it("cycles: unknown state filter is rejected, valid states echoed", async () => {
    const res = await app.inject({ method: "GET", url: "/api/inventory/cycles?state=BOGUS", headers: { cookie } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { states: string[] }).states).toEqual([...CYCLE_STATES]);
  });

  it("summary: zero-filled across every cycle/leg state, hedge kind and op kind", async () => {
    const res = await app.inject({ method: "GET", url: "/api/inventory/summary", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SummaryPayload;
    expect(body.cycles.total).toBe(0);
    expect(body.cycles.byState.map((r) => r.state)).toEqual([...CYCLE_STATES]);
    expect(body.cycles.byState.every((r) => r.n === 0)).toBe(true);
    expect(body.legs.byState.map((r) => r.state)).toEqual([...LEG_STATES]);
    expect(body.hedges.byKind.map((r) => r.kind)).toEqual([
      "COMPLETE_PAIR_TAKER", "DUMP_SURVIVOR_TAKER", "CANCEL_REMAINING_QUOTE", "HOLD_TO_RESOLUTION",
    ]);
    expect(body.operations.byKind.map((r) => r.kind)).toEqual(["SPLIT", "MERGE", "REDEEM"]);
    expect(body.operations.unknownOutcomes).toBe(0);
    expect(body.worstCaseLoss.open).toEqual({ n: 0, sum6: "0", max6: "0" });
    expect(body.unhedged.n).toBe(0);
    expect(body.unhedged.capMs).toBe(2000); // maximum_one_leg_seconds mirror
  });

  it("accruals: two zero ledgers, strictly separate, with the mandated captions", async () => {
    const res = await app.inject({ method: "GET", url: "/api/inventory/accruals", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AccrualsPayload;
    expect(body.makerRebate.program).toBe("MAKER_REBATE");
    expect(body.liquidityReward.program).toBe("LIQUIDITY_REWARD");
    for (const ledger of [body.makerRebate, body.liquidityReward]) {
      expect(ledger.byState.map((r) => r.state)).toEqual([...ACCRUAL_STATES]);
      expect(ledger.realized).toEqual({ n: 0, paid6: "0" });
      expect(ledger.unrealized).toEqual({ n: 0, amount6: "0" });
      expect(ledger.inconsistentRows).toBe(0);
    }
    expect(body.notes).toContain("Rewards are revenue only when paid.");
    expect(body.notes).toContain("Rebate not included until paid.");
    expect(body.notes.some((n) => n.includes("NEVER count toward EV"))).toBe(true);
  });

  it("snapshots + basis: well-formed empty shapes", async () => {
    const snap = await app.inject({ method: "GET", url: "/api/inventory/snapshots", headers: { cookie } });
    expect(snap.statusCode).toBe(200);
    expect(snap.json() as SnapshotsPayload).toMatchObject({ snapshots: [], totals: { n: 0, mismatches: 0 } });
    const bas = await app.inject({ method: "GET", url: "/api/inventory/basis", headers: { cookie } });
    expect(bas.statusCode).toBe(200);
    const body = bas.json() as BasisPayload;
    expect(body.basis.pairs).toEqual([]);
    expect(body.boundary.totals).toEqual({ n: 0, matched: 0, mismatched: 0, unchecked: 0, lateCaptures: 0 });
    expect(body.notes).toContain("Binance is not the resolution source.");
  });
});

describe("inventory lab routes (seeded)", () => {
  const T0 = 1_754_000_000_000;

  beforeAll(async () => {
    const common = { mode: "PAPER", configVersion: 1 };
    await db.db.insert(pairedQuoteCycles).values([
      {
        id: "cyc_done", correlationId: "corr_done", marketId: "mkt_a", ...common, kind: "SPLIT_SELL",
        state: "RECONCILED", targetPairPrice6: 1_020_000n, collateralCommitted6: 10_000_000n,
        worstCaseLoss6: 500_000n, splitOperationId: "op_split_done", mergeOperationId: "op_merge_done",
        oneLegFilledAtMs: T0 + 1_000, hedgeCompletedAtMs: T0 + 1_800, unhedgedDurationMs: 800,
        spreadCaptured6: 30_000n, fees6: 0n, realizedPnl6: 25_000n,
        createdAtMs: T0, updatedAtMs: T0 + 5_000, reconciledAtMs: T0 + 5_000,
      },
      {
        id: "cyc_exposed", correlationId: "corr_exposed", marketId: "mkt_b", ...common, kind: "SPLIT_SELL",
        state: "ONE_LEG_FILLED", targetPairPrice6: 1_030_000n, collateralCommitted6: 20_000_000n,
        worstCaseLoss6: 2_000_000n, splitOperationId: "op_split_unknown", mergeOperationId: null,
        oneLegFilledAtMs: T0 + 10_000, hedgeCompletedAtMs: null, unhedgedDurationMs: 2_500,
        spreadCaptured6: null, fees6: null, realizedPnl6: null,
        createdAtMs: T0 + 8_000, updatedAtMs: T0 + 12_500, reconciledAtMs: null,
      },
      {
        // data-integrity trap: RECONCILED cycle whose leg is still open — the
        // riskFree predicate must refuse it even in the terminal state
        id: "cyc_bad", correlationId: "corr_bad", marketId: "mkt_c", ...common, kind: "BUY_BOTH_MERGE",
        state: "RECONCILED", targetPairPrice6: 980_000n, collateralCommitted6: 5_000_000n,
        worstCaseLoss6: 300_000n, splitOperationId: null, mergeOperationId: null,
        oneLegFilledAtMs: null, hedgeCompletedAtMs: null, unhedgedDurationMs: null,
        spreadCaptured6: null, fees6: null, realizedPnl6: null,
        createdAtMs: T0 + 20_000, updatedAtMs: T0 + 21_000, reconciledAtMs: T0 + 21_000,
      },
    ]);
    await db.db.insert(pairedLegs).values([
      {
        id: "leg_done_up", correlationId: "corr_done", cycleId: "cyc_done", marketId: "mkt_a", tokenId: "tok_up_a",
        outcomeSide: "UP", orderSide: "SELL", state: "HEDGED", price6: 520_000n, size6: 10_000_000n,
        filledShares6: 10_000_000n, avgFillPrice6: 520_000n, feeUsdc6: 0n, attemptId: null,
        quotedAtMs: T0 + 500, firstFillAtMs: T0 + 1_000, unhedgedStartedAtMs: T0 + 1_000, hedgedAtMs: T0 + 1_800,
        closedAtMs: T0 + 1_800, createdAtMs: T0 + 100, updatedAtMs: T0 + 1_800, configVersion: 1,
      },
      {
        id: "leg_done_down", correlationId: "corr_done", cycleId: "cyc_done", marketId: "mkt_a", tokenId: "tok_dn_a",
        outcomeSide: "DOWN", orderSide: "SELL", state: "HEDGED", price6: 500_000n, size6: 10_000_000n,
        filledShares6: 10_000_000n, avgFillPrice6: 500_000n, feeUsdc6: 0n, attemptId: null,
        quotedAtMs: T0 + 500, firstFillAtMs: T0 + 1_800, unhedgedStartedAtMs: null, hedgedAtMs: T0 + 1_800,
        closedAtMs: T0 + 1_800, createdAtMs: T0 + 100, updatedAtMs: T0 + 1_800, configVersion: 1,
      },
      {
        id: "leg_exp_up", correlationId: "corr_exposed", cycleId: "cyc_exposed", marketId: "mkt_b", tokenId: "tok_up_b",
        outcomeSide: "UP", orderSide: "SELL", state: "UNHEDGED", price6: 530_000n, size6: 20_000_000n,
        filledShares6: 20_000_000n, avgFillPrice6: 530_000n, feeUsdc6: null, attemptId: null,
        quotedAtMs: T0 + 9_000, firstFillAtMs: T0 + 10_000, unhedgedStartedAtMs: T0 + 10_000, hedgedAtMs: null,
        closedAtMs: null, createdAtMs: T0 + 8_100, updatedAtMs: T0 + 10_000, configVersion: 1,
      },
      {
        id: "leg_exp_down", correlationId: "corr_exposed", cycleId: "cyc_exposed", marketId: "mkt_b", tokenId: "tok_dn_b",
        outcomeSide: "DOWN", orderSide: "SELL", state: "QUOTED", price6: 500_000n, size6: 20_000_000n,
        filledShares6: 0n, avgFillPrice6: null, feeUsdc6: null, attemptId: null,
        quotedAtMs: T0 + 9_000, firstFillAtMs: null, unhedgedStartedAtMs: null, hedgedAtMs: null,
        closedAtMs: null, createdAtMs: T0 + 8_100, updatedAtMs: T0 + 9_000, configVersion: 1,
      },
      {
        id: "leg_bad_up", correlationId: "corr_bad", cycleId: "cyc_bad", marketId: "mkt_c", tokenId: "tok_up_c",
        outcomeSide: "UP", orderSide: "BUY", state: "UNHEDGED", price6: 490_000n, size6: 5_000_000n,
        filledShares6: 5_000_000n, avgFillPrice6: 490_000n, feeUsdc6: null, attemptId: null,
        quotedAtMs: T0 + 20_100, firstFillAtMs: T0 + 20_500, unhedgedStartedAtMs: T0 + 20_500, hedgedAtMs: null,
        closedAtMs: null, createdAtMs: T0 + 20_050, updatedAtMs: T0 + 20_500, configVersion: 1,
      },
    ]);
    await db.db.insert(hedgeActions).values([
      {
        id: "hedge_done", correlationId: "corr_done", cycleId: "cyc_done", legId: "leg_done_up", marketId: "mkt_a",
        tokenId: "tok_dn_a", kind: "COMPLETE_PAIR_TAKER", state: "DONE", ...common,
        targetShares6: 10_000_000n, executedShares6: 10_000_000n, expectedCost6: 12_000n, actualCost6: 15_000n,
        feeUsdc6: 0n, attemptId: null, unhedgedDurationMs: 800, decidedAtMs: T0 + 1_200, executedAtMs: T0 + 1_800,
        updatedAtMs: T0 + 1_800,
      },
      {
        id: "hedge_exposed", correlationId: "corr_exposed", cycleId: "cyc_exposed", legId: "leg_exp_down", marketId: "mkt_b",
        tokenId: "tok_dn_b", kind: "CANCEL_REMAINING_QUOTE", state: "DONE", ...common,
        targetShares6: 20_000_000n, executedShares6: null, expectedCost6: 0n, actualCost6: null,
        feeUsdc6: null, attemptId: null, unhedgedDurationMs: 2_500, decidedAtMs: T0 + 12_500, executedAtMs: null,
        updatedAtMs: T0 + 12_500,
      },
    ]);
    await db.db.insert(ctfOperations).values([
      {
        id: "op_split_done", correlationId: "corr_done", cycleId: "cyc_done", marketId: "mkt_a", conditionId: "cond_a",
        kind: "SPLIT", state: "CONFIRMED", ...common, requestedAmount6: 10_000_000n, confirmedAmount6: 10_000_000n,
        collateralDelta6: -10_000_000n, estGasUsdc6: 15_000n, actualGasUsdc6: 12_000n, relayed: false,
        txHash: "0xsplitdone", failureReason: null, createdAtMs: T0 + 200, submittedAtMs: T0 + 250,
        confirmedAtMs: T0 + 400, updatedAtMs: T0 + 400,
      },
      {
        id: "op_merge_done", correlationId: "corr_done", cycleId: "cyc_done", marketId: "mkt_a", conditionId: "cond_a",
        kind: "MERGE", state: "CONFIRMED", ...common, requestedAmount6: 10_000_000n, confirmedAmount6: 10_000_000n,
        collateralDelta6: 10_000_000n, estGasUsdc6: 15_000n, actualGasUsdc6: 18_000n, relayed: false,
        txHash: "0xmergedone", failureReason: null, createdAtMs: T0 + 2_000, submittedAtMs: T0 + 2_050,
        confirmedAtMs: T0 + 2_400, updatedAtMs: T0 + 2_400,
      },
      {
        id: "op_split_unknown", correlationId: "corr_exposed", cycleId: "cyc_exposed", marketId: "mkt_b", conditionId: "cond_b",
        kind: "SPLIT", state: "UNKNOWN", ...common, requestedAmount6: 20_000_000n, confirmedAmount6: null,
        collateralDelta6: null, estGasUsdc6: 20_000n, actualGasUsdc6: null, relayed: true,
        txHash: null, failureReason: "rpc timeout — outcome ambiguous", createdAtMs: T0 + 8_200,
        submittedAtMs: T0 + 8_250, confirmedAtMs: null, updatedAtMs: T0 + 8_500,
      },
    ]);
    await db.db.insert(rebateAccruals).values([
      {
        id: "reb_paid", correlationId: "corr_done", programVersion: "rebate_v1", marketId: "mkt_a", cycleId: "cyc_done",
        fillId: "fill_1", basisShares6: 10_000_000n, basisNotional6: 5_200_000n, amount6: 40_000n,
        state: "PAID", realized: true, paidAmount6: 42_000n, paidAtMs: T0 + 90_000,
        createdAtMs: T0 + 2_000, updatedAtMs: T0 + 90_000, configVersion: 1,
      },
      {
        id: "reb_accrued", correlationId: "corr_done", programVersion: "rebate_v1", marketId: "mkt_a", cycleId: "cyc_done",
        fillId: "fill_2", basisShares6: 10_000_000n, basisNotional6: 5_000_000n, amount6: 10_000n,
        state: "ACCRUED", realized: false, paidAmount6: null, paidAtMs: null,
        createdAtMs: T0 + 2_100, updatedAtMs: T0 + 2_100, configVersion: 1,
      },
      {
        id: "reb_disputed", correlationId: "corr_exposed", programVersion: "rebate_v1", marketId: "mkt_b", cycleId: "cyc_exposed",
        fillId: "fill_3", basisShares6: 20_000_000n, basisNotional6: 10_600_000n, amount6: 5_000n,
        state: "DISPUTED", realized: false, paidAmount6: null, paidAtMs: null,
        createdAtMs: T0 + 11_000, updatedAtMs: T0 + 12_000, configVersion: 1,
      },
    ]);
    await db.db.insert(liquidityRewardAccruals).values([
      {
        id: "rew_pending", correlationId: "corr_epoch1", programVersion: "reward_v1", marketId: null, epochKey: "2026-08-01",
        qualifyingUptimeMs: 3_600_000, scoreDetail: { spreadScore: 0.8 }, amount6: 30_000n,
        state: "PENDING", realized: false, paidAmount6: null, paidAtMs: null,
        createdAtMs: T0 + 3_000, updatedAtMs: T0 + 3_000, configVersion: 1,
      },
      {
        id: "rew_paid", correlationId: "corr_epoch2", programVersion: "reward_v1", marketId: null, epochKey: "2026-08-02",
        qualifyingUptimeMs: 7_200_000, scoreDetail: null, amount6: 20_000n,
        state: "PAID", realized: true, paidAmount6: 20_000n, paidAtMs: T0 + 95_000,
        createdAtMs: T0 + 4_000, updatedAtMs: T0 + 95_000, configVersion: 1,
      },
      {
        // invariant violation on purpose: realized=true outside PAID — the
        // route must count it as inconsistent, never as revenue
        id: "rew_bad", correlationId: "corr_epoch3", programVersion: "reward_v1", marketId: "mkt_a", epochKey: "2026-08-03",
        qualifyingUptimeMs: null, scoreDetail: null, amount6: 7_000n,
        state: "ACCRUED", realized: true, paidAmount6: null, paidAtMs: null,
        createdAtMs: T0 + 5_000, updatedAtMs: T0 + 5_000, configVersion: 1,
      },
    ]);
    await db.db.insert(inventorySnapshots).values([
      {
        id: "snap_ok", correlationId: "corr_done", marketId: "mkt_a", ...common,
        upShares6: 10_000_000n, downShares6: 10_000_000n, pairedShares6: 10_000_000n,
        unpairedUpShares6: 0n, unpairedDownShares6: 0n, reservedUpShares6: 0n, reservedDownShares6: 0n,
        collateralFree6: 90_000_000n, exchangeUpShares6: 10_000_000n, exchangeDownShares6: 10_000_000n,
        onchainUpShares6: 10_000_000n, onchainDownShares6: 10_000_000n,
        reconciled: true, divergence: null, tsMs: T0 + 6_000,
      },
      {
        id: "snap_bad", correlationId: "corr_exposed", marketId: "mkt_b", ...common,
        upShares6: 20_000_000n, downShares6: 20_000_000n, pairedShares6: 20_000_000n,
        unpairedUpShares6: 0n, unpairedDownShares6: 0n, reservedUpShares6: 20_000_000n, reservedDownShares6: 0n,
        collateralFree6: null, exchangeUpShares6: 19_000_000n, exchangeDownShares6: 20_000_000n,
        onchainUpShares6: null, onchainDownShares6: null,
        reconciled: false, divergence: { exchangeUpDelta6: "-1000000" }, tsMs: T0 + 13_000,
      },
    ]);
    await db.db.insert(feedBasisEstimates).values([
      {
        id: "fb_old", correlationId: "corr_fb", symbol: "BTCUSD", baseSource: "binance", refSource: "chainlink",
        windowStartMs: T0 - 600_000, windowEndMs: T0 - 300_000, sampleCount: 900,
        meanPpm: 1000, medianPpm: 990, stdPpm: 120, madPpm: 80, clockOffsetMs: 40, leadLagMs: 350,
        regime: "calm", method: "rolling_robust_v1", tsMs: T0 - 300_000, configVersion: 1,
      },
      {
        id: "fb_new", correlationId: "corr_fb", symbol: "BTCUSD", baseSource: "binance", refSource: "chainlink",
        windowStartMs: T0 - 300_000, windowEndMs: T0, sampleCount: 1_100,
        meanPpm: 1200, medianPpm: 1210, stdPpm: 140, madPpm: 90, clockOffsetMs: 42, leadLagMs: 360,
        regime: "calm", method: "rolling_robust_v1", tsMs: T0, configVersion: 1,
      },
    ]);
    await db.db.insert(boundaryPriceObservations).values([
      {
        id: "bo_open_ok", correlationId: "corr_bo", marketId: "mkt_a", symbol: "BTCUSD", boundaryKind: "OPEN",
        boundaryEpoch: 1_754_000_100, valueText: "65123.45000000", valueFloat: 65123.45, source: "rtds_chainlink",
        sourceTsMs: T0 + 100_100, receivedTsMs: T0 + 100_150, sequence: "round-77",
        firstAtOrAfterBoundary: true, officialValueText: "65123.45", matchesOfficial: true, configVersion: 1,
      },
      {
        id: "bo_close_late", correlationId: "corr_bo", marketId: "mkt_a", symbol: "BTCUSD", boundaryKind: "CLOSE",
        boundaryEpoch: 1_754_000_400, valueText: "65200.00000000", valueFloat: 65200, source: "rtds_chainlink",
        sourceTsMs: T0 + 400_900, receivedTsMs: T0 + 401_000, sequence: null,
        firstAtOrAfterBoundary: false, officialValueText: null, matchesOfficial: null, configVersion: 1,
      },
      {
        id: "bo_open_mismatch", correlationId: "corr_bo", marketId: "mkt_b", symbol: "BTCUSD", boundaryKind: "OPEN",
        boundaryEpoch: 1_754_000_700, valueText: "65250.10000000", valueFloat: 65250.1, source: "rtds_chainlink",
        sourceTsMs: T0 + 700_050, receivedTsMs: T0 + 700_090, sequence: "round-79",
        firstAtOrAfterBoundary: true, officialValueText: "65251.00", matchesOfficial: false, configVersion: 1,
      },
    ]);
  });

  it("cycles: recent-first with nested legs, hedges and ops; riskFree is the domain predicate", async () => {
    const res = await app.inject({ method: "GET", url: "/api/inventory/cycles", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as CyclesPayload;
    expect(body.cycles.map((c) => c.id)).toEqual(["cyc_bad", "cyc_exposed", "cyc_done"]);

    const done = body.cycles.find((c) => c.id === "cyc_done")!;
    expect(done.riskFree).toBe(true); // RECONCILED + both legs HEDGED — the ONLY risk-free shape
    expect(done.legs.map((l) => l.id).sort()).toEqual(["leg_done_down", "leg_done_up"]);
    expect(done.hedgeActions.map((h) => h.id)).toEqual(["hedge_done"]);
    expect(done.ctfOperations.map((o) => o.id).sort()).toEqual(["op_merge_done", "op_split_done"]);
    expect(done.worstCaseLoss6).toBe("500000");

    // a split position is not risk-free while a leg is open
    const exposed = body.cycles.find((c) => c.id === "cyc_exposed")!;
    expect(exposed.riskFree).toBe(false);
    expect(exposed.unhedgedDurationMs).toBe(2500);
    expect(exposed.ctfOperations[0]!.state).toBe("UNKNOWN");
    expect(exposed.ctfOperations[0]!.failureReason).toContain("ambiguous");

    // even RECONCILED cannot be risk-free with an open (UNHEDGED) leg
    const bad = body.cycles.find((c) => c.id === "cyc_bad")!;
    expect(bad.state).toBe("RECONCILED");
    expect(bad.riskFree).toBe(false);
  });

  it("cycles: state filter narrows to matching cycles only", async () => {
    const res = await app.inject({ method: "GET", url: "/api/inventory/cycles?state=ONE_LEG_FILLED", headers: { cookie } });
    const body = res.json() as CyclesPayload;
    expect(body.cycles.map((c) => c.id)).toEqual(["cyc_exposed"]);
    expect(body.cycles[0]!.legs).toHaveLength(2);
  });

  it("summary: state counts, one-leg incidence, hedge/cancel split, op gas totals, worst-case and unhedged-cap aggregates", async () => {
    const res = await app.inject({ method: "GET", url: "/api/inventory/summary", headers: { cookie } });
    const body = res.json() as SummaryPayload;
    const stateBy = new Map(body.cycles.byState.map((r) => [r.state, r.n]));
    expect(body.cycles.total).toBe(3);
    expect(stateBy.get("RECONCILED")).toBe(2);
    expect(stateBy.get("ONE_LEG_FILLED")).toBe(1);
    expect(body.cycles.oneLegFilled).toBe(2); // cyc_done + cyc_exposed ever had one leg filled
    expect(body.cycles.hedgeCompleted).toBe(1);

    const legBy = new Map(body.legs.byState.map((r) => [r.state, r.n]));
    expect(legBy.get("HEDGED")).toBe(2);
    expect(legBy.get("UNHEDGED")).toBe(2);
    expect(legBy.get("QUOTED")).toBe(1);

    const hedgeBy = new Map(body.hedges.byKind.map((r) => [r.kind, r]));
    expect(hedgeBy.get("COMPLETE_PAIR_TAKER")).toMatchObject({ n: 1, done: 1, failed: 0 });
    expect(hedgeBy.get("CANCEL_REMAINING_QUOTE")).toMatchObject({ n: 1, done: 1, failed: 0 });
    expect(hedgeBy.get("DUMP_SURVIVOR_TAKER")).toMatchObject({ n: 0 });

    const opBy = new Map(body.operations.byKind.map((r) => [r.kind, r]));
    expect(opBy.get("SPLIT")).toMatchObject({ n: 2, confirmed: 1, unknown: 1, estGas6: "35000", actualGas6: "12000" });
    expect(opBy.get("MERGE")).toMatchObject({ n: 1, confirmed: 1, estGas6: "15000", actualGas6: "18000" });
    expect(opBy.get("REDEEM")).toMatchObject({ n: 0 });
    expect(body.operations.unknownOutcomes).toBe(1);
    expect(body.operations.estGas6).toBe("50000");
    expect(body.operations.actualGas6).toBe("30000");
    expect(body.operations.recent.length).toBe(3);

    expect(body.worstCaseLoss.all).toMatchObject({ n: 3, sum6: "2800000", max6: "2000000" });
    expect(body.worstCaseLoss.open).toMatchObject({ n: 1, sum6: "2000000", max6: "2000000" }); // only cyc_exposed is unreconciled

    expect(body.unhedged.n).toBe(2);
    expect(body.unhedged.maxMs).toBe(2500);
    expect(body.unhedged.overCapCount).toBe(1); // 2500ms > the 2s one-leg cap
  });

  it("accruals: ledgers strictly separate; realized counts PAID paid_amount6 only; invariant violations surface", async () => {
    const res = await app.inject({ method: "GET", url: "/api/inventory/accruals", headers: { cookie } });
    const body = res.json() as AccrualsPayload;

    // maker rebates: PAID 42000 (paid_amount6, not the 40000 estimate)
    const reb = body.makerRebate;
    expect(reb.realized).toEqual({ n: 1, paid6: "42000" });
    expect(reb.unrealized).toEqual({ n: 2, amount6: "15000" }); // ACCRUED 10000 + DISPUTED 5000
    const rebBy = new Map(reb.byState.map((r) => [r.state, r]));
    expect(rebBy.get("DISPUTED")).toMatchObject({ n: 1, amount6: "5000" });
    expect(reb.inconsistentRows).toBe(0);
    expect(reb.byState.reduce((a, r) => a + r.n, 0)).toBe(3); // no reward row leaked in

    // liquidity rewards: PAID 20000; the realized=true-outside-PAID row is
    // flagged inconsistent and stays unrealized
    const rew = body.liquidityReward;
    expect(rew.realized).toEqual({ n: 1, paid6: "20000" });
    expect(rew.unrealized).toEqual({ n: 2, amount6: "37000" }); // PENDING 30000 + bad ACCRUED 7000
    expect(rew.inconsistentRows).toBe(1);
    expect(rew.byState.reduce((a, r) => a + r.n, 0)).toBe(3); // no rebate row leaked in

    expect(body.notes).toContain("Rewards are revenue only when paid.");
  });

  it("snapshots: recent-first with mismatch count and structured divergence", async () => {
    const res = await app.inject({ method: "GET", url: "/api/inventory/snapshots", headers: { cookie } });
    const body = res.json() as SnapshotsPayload;
    expect(body.totals).toEqual({ n: 2, mismatches: 1 });
    expect(body.snapshots.map((s) => s.id)).toEqual(["snap_bad", "snap_ok"]);
    expect(body.snapshots[0]!.reconciled).toBe(false);
    expect(body.snapshots[0]!.divergence).toEqual({ exchangeUpDelta6: "-1000000" });
  });

  it("basis: per-pair stats keep the latest estimate; boundary official cross-check and late captures are explicit", async () => {
    const res = await app.inject({ method: "GET", url: "/api/inventory/basis", headers: { cookie } });
    const body = res.json() as BasisPayload;
    expect(body.basis.pairs).toHaveLength(1);
    const pair = body.basis.pairs[0]!;
    expect(pair.symbol).toBe("BTCUSD");
    expect(pair.estimates).toBe(2);
    expect(pair.latest.meanPpm).toBe(1200); // newest tsMs wins
    expect(pair.meanPpmMin).toBe(1000);
    expect(pair.meanPpmMax).toBe(1200);

    expect(body.boundary.totals).toEqual({ n: 3, matched: 1, mismatched: 1, unchecked: 1, lateCaptures: 1 });
    const openKind = body.boundary.byKind.find((k) => k.kind === "OPEN")!;
    expect(openKind.n).toBe(2);
    const late = body.boundary.recent.find((r) => r.id === "bo_close_late")!;
    expect(late.firstAtOrAfterBoundary).toBe(false); // late capture — never authoritative
  });
});

describe("inventory lab routes (tables absent)", () => {
  beforeAll(async () => {
    // simulate a database that predates the inventory migration
    await db.db.execute(sql`
      drop table if exists paired_legs, hedge_actions, ctf_operations, inventory_lots,
        inventory_snapshots, rebate_accruals, liquidity_reward_accruals, paired_quote_cycles,
        feed_basis_estimates, boundary_price_observations cascade
    `);
  });

  it("every route degrades to its well-formed empty payload with a note", async () => {
    const cyc = await app.inject({ method: "GET", url: "/api/inventory/cycles", headers: { cookie } });
    expect(cyc.statusCode).toBe(200);
    expect(cyc.json() as CyclesPayload).toMatchObject({ cycles: [], note: expect.stringContaining("unavailable") as unknown as string });

    const sum = await app.inject({ method: "GET", url: "/api/inventory/summary", headers: { cookie } });
    expect(sum.statusCode).toBe(200);
    const sumBody = sum.json() as SummaryPayload;
    expect(sumBody.note).toContain("unavailable");
    expect(sumBody.cycles.total).toBe(0);
    expect(sumBody.cycles.byState.map((r) => r.state)).toEqual([...CYCLE_STATES]);
    expect(sumBody.worstCaseLoss.open).toEqual({ n: 0, sum6: "0", max6: "0" });

    const acc = await app.inject({ method: "GET", url: "/api/inventory/accruals", headers: { cookie } });
    expect(acc.statusCode).toBe(200);
    const accBody = acc.json() as AccrualsPayload;
    expect(accBody.note).toContain("unavailable");
    expect(accBody.makerRebate.realized).toEqual({ n: 0, paid6: "0" });
    expect(accBody.liquidityReward.realized).toEqual({ n: 0, paid6: "0" });
    expect(accBody.notes).toContain("Rewards are revenue only when paid.");

    const snap = await app.inject({ method: "GET", url: "/api/inventory/snapshots", headers: { cookie } });
    expect(snap.statusCode).toBe(200);
    expect(snap.json() as SnapshotsPayload).toMatchObject({ snapshots: [], totals: { n: 0, mismatches: 0 }, note: expect.stringContaining("unavailable") as unknown as string });

    const bas = await app.inject({ method: "GET", url: "/api/inventory/basis", headers: { cookie } });
    expect(bas.statusCode).toBe(200);
    const basBody = bas.json() as BasisPayload;
    expect(basBody.note).toContain("unavailable");
    expect(basBody.basis.pairs).toEqual([]);
    expect(basBody.boundary.totals.n).toBe(0);
  });
});

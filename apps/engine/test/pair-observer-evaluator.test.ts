import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppConfigSchema } from "@b5p/config";
import { makeDb, schema, type DbHandle } from "@b5p/db";
import { canonicalObjectHash, type PairPortfolioSnapshot, type PairTokenTerms, type PairTokenTermsProvider } from "@b5p/pair-execution";
import { getLocalBus } from "../src/bus";
import { Engine } from "../src/engine";
import { PairObservationStore } from "../src/pair-observation-store";
import { PairObserverEvaluator, type PairObserverResult } from "../src/pair-observer-evaluator";
import { buildPairPolicySnapshot } from "../src/pair-policy";

const NOW = 1_800_000_000_000;
const UP = "up-token";
const DOWN = "down-token";
const MARKET = "market-1";
const CONDITION = "condition-1";

let db: DbHandle;
let engine: Engine;

function tokenTerms(outcome: "UP" | "DOWN", tokenId: string): PairTokenTerms {
  return Object.freeze({
    outcome,
    tokenId,
    constraints: Object.freeze({
      snapshotId: `constraint-${tokenId}`, tokenId, tickSize6: 10_000n, minimumOrderShares6: 1_000_000n,
      effectiveAtMs: NOW, fetchedAtMs: NOW, source: "fixture", canonicalHash: `constraint-hash-${tokenId}`,
    }),
    fee: Object.freeze({
      snapshotId: `fee-${tokenId}`, tokenId, tokenFeeRatePpm: 0n, convention: "USDC",
      conventionResolverVersion: "fixture-v1", effectiveAtMs: NOW, fetchedAtMs: NOW,
      source: "fixture", canonicalHash: `fee-hash-${tokenId}`,
    }),
  });
}

const readyTerms: PairTokenTermsProvider = {
  currentTerms: async () => ({ kind: "READY", up: tokenTerms("UP", UP), down: tokenTerms("DOWN", DOWN) }),
};

function portfolio(overrides: Partial<PairPortfolioSnapshot> = {}): PairPortfolioSnapshot {
  const value = {
    snapshotId: "portfolio-1", referenceBankroll6: 100_000_000n, pairAccountCashBalance6: 100_000_000n,
    pairCashReserved6: 0n, pairPendingSettlementReserved6: 0n, pairCashAvailable6: 100_000_000n,
    directionalFreeCash6: 100_000_000n, sharedCapAvailable6: 100_000_000n, globalAppMode: "observe" as const,
    directionalLiveArmed: false, activePairGroupCount: 0, aggregatePairWorstCaseLoss6: 0n,
    pairDailyRealizedPnl6: 0n, pairSessionPeakCash6: 100_000_000n,
    activeDirectionalMarketIds: [], openDirectionalMarketIds: [], activePairMarketIds: [],
    reconciledAtMs: NOW, healthy: true,
    ...overrides,
  };
  return Object.freeze({ ...value, hash: canonicalObjectHash(value) });
}

function snapshot(upAsk: string, downAsk: string, ts = NOW): void {
  engine.onBookSnapshot(UP, [{ price: "0.47", size: "2" }], [{ price: upAsk, size: "2" }], ts, ts, {
    connectionEpoch: "epoch-1", marketId: MARKET, sourceEventId: `snapshot-up-${ts}`,
  });
  engine.onBookSnapshot(DOWN, [{ price: "0.48", size: "2" }], [{ price: downAsk, size: "2" }], ts, ts, {
    connectionEpoch: "epoch-1", marketId: MARKET, sourceEventId: `snapshot-down-${ts}`,
  });
}

function evaluator(input: {
  terms?: PairTokenTermsProvider;
  portfolio?: () => Promise<PairPortfolioSnapshot>;
  results?: PairObserverResult[];
  health?: ReturnType<typeof vi.fn>;
}) {
  const results = input.results ?? [];
  const policy = buildPairPolicySnapshot(AppConfigSchema.parse({ pair: {
    minimum_net_pnl_usdc: "0.001", minimum_net_return: "0",
    operational_risk_haircut_usdc: "0", negative_control_sample_ppm: 1_000_000,
  } }), 1, "test");
  return new PairObserverEvaluator({
    engine,
    terms: input.terms ?? readyTerms,
    observations: new PairObservationStore(db),
    policy: () => policy,
    observerOperationalHash: () => "observer-ops",
    portfolio: input.portfolio ?? (async () => portfolio()),
    requestedCashCap6: () => 10_000_000n,
    prefilterBand6: 5_000n,
    maximumMarkets: 2,
    nowMs: () => NOW + 10,
    onHealth: input.health ?? vi.fn(),
    onResult: (result) => results.push(result),
  });
}

beforeEach(async () => {
  db = await makeDb({ pgliteDir: "memory://" });
  await db.migrate();
  engine = new Engine(db, getLocalBus(), "observe");
});

afterEach(async () => {
  engine.stop();
  await db.close();
});

describe("pair observer evaluator", () => {
  it("evaluates exactly once after the complete cross-token envelope and never sees its transient half-state", async () => {
    snapshot("0.50", "0.50");
    const results: PairObserverResult[] = [];
    const observer = evaluator({ results });
    observer.registerMarket({ marketId: MARKET, conditionId: CONDITION, upTokenId: UP, downTokenId: DOWN, mode: "observe" });
    engine.setPairEnvelopeDirtyMarker((marketId, envelopeId) => { observer.markDirty(marketId, { kind: "CLOB_ENVELOPE", id: envelopeId }); });

    // The UP mutation alone creates 0.49 + 0.50 < 1. The second mutation in
    // the same envelope removes it. The evaluator can only snapshot after both.
    engine.onPriceChangeEnvelope({
      envelopeId: "envelope-atomic", marketId: MARKET, sourceTsMs: NOW + 10, receivedTsMs: NOW + 10,
      changes: [
        { assetId: UP, price: "0.50", size: "0", side: "SELL", hash: "up-final" },
        { assetId: UP, price: "0.49", size: "2", side: "SELL", hash: "up-final" },
        { assetId: DOWN, price: "0.50", size: "0", side: "SELL", hash: "down-final" },
        { assetId: DOWN, price: "0.51", size: "2", side: "SELL", hash: "down-final" },
      ],
      meta: { connectionEpoch: "epoch-1", sourceEventId: "source-atomic" },
    });
    await observer.whenIdle(MARKET);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: "EVALUATED", episodeState: null, counterfactualEligible: false });
    const rows = await db.db.select().from(schema.pairOpportunityObservations);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ triggerId: "envelope-atomic", grossTopOfBookEdge6: 0n });
    expect(await db.db.select().from(schema.pairBookCaptures)).toHaveLength(1);
  });

  it("persists an exact quote/risk observation while remaining structurally observer-only and trigger-idempotent", async () => {
    snapshot("0.48", "0.49", NOW + 10);
    const results: PairObserverResult[] = [];
    const observer = evaluator({ results });
    observer.registerMarket({ marketId: MARKET, conditionId: CONDITION, upTokenId: UP, downTokenId: DOWN, mode: "observe" });

    expect(observer.markDirty(MARKET, { kind: "CLOB_ENVELOPE", id: "eligible" })).toBe("SCHEDULED");
    expect(observer.markDirty(MARKET, { kind: "CLOB_ENVELOPE", id: "eligible" })).toBe("DUPLICATE");
    await observer.whenIdle(MARKET);
    expect(observer.markDirty(MARKET, { kind: "CLOB_ENVELOPE", id: "eligible" })).toBe("DUPLICATE");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: "EVALUATED", episodeState: "NET_ELIGIBLE", counterfactualEligible: true,
      paperSchedulingPermitted: false, selectedPairShares6: 2_000_000n, rejectionCodes: [],
    });
    const observations = await db.db.select().from(schema.pairOpportunityObservations);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ selectedPairShares6: 2_000_000n, netPreLatencyPnl6: 60_000n });
    expect(await db.db.select().from(schema.orderIntents)).toHaveLength(0);
    expect(await db.db.select().from(schema.pairOrderGroups)).toHaveLength(0);
    expect(await db.db.select().from(schema.pairPaperAccounts)).toHaveLength(0);
  });

  it("returns ordinary capture and terms invalidity as data without throwing or creating partial observations", async () => {
    snapshot("0.48", "0.49", NOW - 10_000);
    const staleResults: PairObserverResult[] = [];
    const stale = evaluator({ results: staleResults });
    stale.registerMarket({ marketId: MARKET, conditionId: CONDITION, upTokenId: UP, downTokenId: DOWN, mode: "observe" });
    stale.markDirty(MARKET, { kind: "CLOB_ENVELOPE", id: "stale" });
    await stale.whenIdle(MARKET);
    expect(staleResults[0]).toMatchObject({ kind: "REJECTED", phase: "CAPTURE" });

    snapshot("0.48", "0.49", NOW + 10);
    const termResults: PairObserverResult[] = [];
    const missingTerms: PairTokenTermsProvider = {
      currentTerms: async () => ({ kind: "REJECTED", code: "FEE_SNAPSHOT_MISSING", detail: "fixture missing" }),
    };
    const noTerms = evaluator({ results: termResults, terms: missingTerms });
    noTerms.registerMarket({ marketId: MARKET, conditionId: CONDITION, upTokenId: UP, downTokenId: DOWN, mode: "observe" });
    noTerms.markDirty(MARKET, { kind: "CLOB_ENVELOPE", id: "no-terms" });
    await noTerms.whenIdle(MARKET);
    expect(termResults[0]).toMatchObject({ kind: "REJECTED", phase: "TERMS", reasons: [{ code: "FEE_SNAPSHOT_MISSING" }] });
    expect(await db.db.select().from(schema.pairOpportunityObservations)).toHaveLength(0);
    expect(await db.db.select().from(schema.pairBookCaptures)).toHaveLength(0);
  });

  it("persists a fail-closed portfolio rejection and does not escalate ordinary data unavailability to runtime health", async () => {
    snapshot("0.48", "0.49", NOW + 10);
    const results: PairObserverResult[] = [];
    const observer = evaluator({ results, portfolio: async () => { throw new Error("portfolio reconciliation unavailable"); } });
    observer.registerMarket({ marketId: MARKET, conditionId: CONDITION, upTokenId: UP, downTokenId: DOWN, mode: "observe" });
    observer.markDirty(MARKET, { kind: "CLOB_ENVELOPE", id: "portfolio-failure" });
    await observer.whenIdle(MARKET);

    expect(results[0]).toMatchObject({ kind: "REJECTED", phase: "PORTFOLIO", reasons: [{ code: "PORTFOLIO_UNRECONCILED" }] });
    const observations = await db.db.select().from(schema.pairOpportunityObservations);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ primaryRejectionCode: "PORTFOLIO_UNRECONCILED" });
  });

  it("isolates an unexpected calculation failure by disabling only the affected market", async () => {
    snapshot("0.48", "0.49", NOW + 10);
    const health = vi.fn();
    const currentTerms = vi.fn(async () => { throw new Error("unexpected fixture failure"); });
    const observer = evaluator({ health, terms: { currentTerms } });
    observer.registerMarket({ marketId: MARKET, conditionId: CONDITION, upTokenId: UP, downTokenId: DOWN, mode: "observe" });

    observer.markDirty(MARKET, { kind: "CLOB_ENVELOPE", id: "unexpected-1" });
    await observer.whenIdle(MARKET);
    observer.markDirty(MARKET, { kind: "CLOB_ENVELOPE", id: "unexpected-2" });
    await observer.whenIdle(MARKET);

    expect(currentTerms).toHaveBeenCalledTimes(1);
    expect(health).toHaveBeenCalledWith("PAIR_RUNTIME_EVALUATION_FAILED", expect.objectContaining({ marketId: MARKET, triggerId: "unexpected-1" }));
    expect(await db.db.select().from(schema.pairOpportunityObservations)).toHaveLength(0);
  });
});

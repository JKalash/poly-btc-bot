import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppConfigSchema, type AppConfig } from "@b5p/config";
import { makeDb, schema, type DbHandle } from "@b5p/db";
import type { PairExecutionDependencies, PairPortfolioSnapshot } from "@b5p/pair-execution";
import { eq } from "drizzle-orm";
import { PairAccountStore } from "../src/pair-account-store";
import { PairObservationStore } from "../src/pair-observation-store";
import { PairOutboxDispatcher } from "../src/pair-outbox-dispatcher";
import { PairStore } from "../src/pair-store";
import { PersistedPairTokenTermsProvider } from "../src/pair-token-terms";
import { DbPaperPairOperationStore, PaperPairVenue } from "../src/paper-pair-venue";
import { createPairSubsystem, PairSubsystemConfigurationError, type CreatePairSubsystemOptions } from "../src/pair-subsystem";

const now = 1_800_000_000_000;
let db: DbHandle;

beforeEach(async () => {
  db = await makeDb({ pgliteDir: "memory://" });
  await db.migrate();
});

afterEach(async () => { await db.close(); });

const portfolio: PairPortfolioSnapshot = {
  snapshotId: "portfolio", referenceBankroll6: 100_000_000n, pairAccountCashBalance6: 100_000_000n,
  pairCashReserved6: 0n, pairPendingSettlementReserved6: 0n, pairCashAvailable6: 100_000_000n,
  directionalFreeCash6: 100_000_000n, sharedCapAvailable6: 100_000_000n, globalAppMode: "paper",
  directionalLiveArmed: false, activePairGroupCount: 0, aggregatePairWorstCaseLoss6: 0n,
  pairDailyRealizedPnl6: 0n, pairSessionPeakCash6: 100_000_000n,
  activeDirectionalMarketIds: [], openDirectionalMarketIds: [], activePairMarketIds: [],
  reconciledAtMs: now, healthy: true, hash: "portfolio-hash",
};

function options(config: AppConfig, overrides: Partial<CreatePairSubsystemOptions> = {}): CreatePairSubsystemOptions {
  return {
    db,
    config,
    configVersion: 7,
    sourceVersion: "commit-test",
    startupRunKey: "startup-test",
    engine: { books: new Map() },
    termsSource: { fetchTokenTerms: async () => null },
    portfolio: async () => portfolio,
    requestedCashCap6: () => 1_000_000n,
    maximumObserverMarkets: 10,
    nowMs: () => now,
    ...overrides,
  };
}

function facadeDependencies(): PairExecutionDependencies {
  return {
    economics: { evaluate: async () => ({ kind: "NO_OBSERVATION", reasons: [] }) },
    observations: { record: async () => ({ kind: "RECORDED", observationId: "observation" as never }) },
    account: { approveSchedule: async () => ({ kind: "REJECTED", reasons: [] }) },
    activation: {
      prepareSchedule: async () => ({ kind: "REJECTED", reasons: [] }),
      prepareDueWork: async () => ({ kind: "NO_ACTION", reason: "test" }),
    },
    store: {
      commitSchedule: async () => ({ kind: "COMMITTED" }),
      listDueWork: async () => [],
      commitDuePlan: async () => ({ kind: "STALE", effects: [] }),
      commitHalt: async () => ({ haltedGroupCount: 0, alreadyHaltedGroupCount: 0, effects: [] }),
      getGroup: async () => null,
      listActiveGroups: async () => [],
    },
    effects: { dispatchCommitted: async () => {}, ingestAvailableEvidence: async () => 0 },
    reconciliation: {
      reconcile: async () => ({
        inspectedGroupCount: 0, healthyGroupCount: 0, repairedGroupCount: 0,
        pendingGroupCount: 0, manualReviewGroupCount: 0,
      }),
    },
  };
}

describe("BPAIR-080 pair subsystem startup composition", () => {
  it("constructs the isolated observer stack with no live or directional execution capability", async () => {
    const subsystem = await createPairSubsystem(options(AppConfigSchema.parse({})));

    expect(subsystem.capability).toMatchObject({
      observerConfigured: true, paperSchedulingConfigured: false, paperSchedulingAllowed: false,
      liveExecutionAvailable: false, facadeConstructed: true, unwiredReasons: [], configVersion: 7,
    });
    expect(subsystem.configuredAuthority.liveExecutionAvailable).toBe(false);
    expect(subsystem.authority.liveExecutionAvailable).toBe(false);
    expect(subsystem.stores.groups).toBeInstanceOf(PairStore);
    expect(subsystem.stores.accounts).toBeInstanceOf(PairAccountStore);
    expect(subsystem.stores.observations).toBeInstanceOf(PairObservationStore);
    expect(subsystem.stores.paperOperations).toBeInstanceOf(DbPaperPairOperationStore);
    expect(subsystem.terms).toBeInstanceOf(PersistedPairTokenTermsProvider);
    expect(subsystem.venue).toBeInstanceOf(PaperPairVenue);
    expect(subsystem.dispatcher).toBeInstanceOf(PairOutboxDispatcher);
    expect(subsystem.healthSnapshot()).toMatchObject({
      status: "HEALTHY", observerAllowed: true, paperSchedulingAllowed: false,
    });
    expect(subsystem.observer.registerMarket({
      marketId: "market", conditionId: "condition", upTokenId: "up", downTokenId: "down", mode: "observe",
    })).toBe(true);
  });

  it("fails paper scheduling closed with explicit unwired reasons while observation remains available", async () => {
    const config = AppConfigSchema.parse({ pair: { paper_execution_enabled: true } });
    const subsystem = await createPairSubsystem(options(config));

    expect(subsystem.startup.paperSchedulingAllowed).toBe(true);
    expect(subsystem.capability).toMatchObject({
      paperSchedulingConfigured: true, paperSchedulingAllowed: false, facadeConstructed: true,
      unwiredReasons: ["PAIR_LIFECYCLE_ATOMICITY_UNAVAILABLE", "PAIR_EFFECT_LEGALITY_UNWIRED"],
    });
    expect(subsystem.authority.paperSchedulingEnabled).toBe(false);
    expect(subsystem.healthSnapshot()).toMatchObject({
      status: "UNHEALTHY", observerAllowed: true, paperSchedulingAllowed: false,
      reasons: [{ code: "PAIR_SUBSYSTEM_UNWIRED" }],
    });
  });

  it("constructs the facade only from complete ports but reconciliation still controls its paper authority", async () => {
    const config = AppConfigSchema.parse({ pair: { paper_execution_enabled: true } });
    await new PairAccountStore(db).createAccount({
      id: "drifted-account", sessionKey: "drifted-session", sourceConfigVersion: 7,
      startingCash6: 50_000_000n, dailyBucketUtc: "2027-01-15", createdAtMs: now - 10,
    });
    await db.db.update(schema.pairPaperAccounts).set({ cashAvailable6: 49_999_999n })
      .where(eq(schema.pairPaperAccounts.id, "drifted-account"));

    const subsystem = await createPairSubsystem(options(config, {
      facadeDependencies: facadeDependencies(),
      isEffectLegal: async () => true,
    }));

    expect(subsystem.startup).toMatchObject({ status: "BLOCKED", paperSchedulingAllowed: false });
    expect(subsystem.facade).not.toBeNull();
    expect(subsystem.capability).toMatchObject({
      facadeConstructed: true, unwiredReasons: [], paperSchedulingConfigured: true, paperSchedulingAllowed: false,
    });
    expect(subsystem.authority.paperSchedulingEnabled).toBe(false);
    expect(subsystem.healthSnapshot()).toMatchObject({
      status: "UNHEALTHY", observerAllowed: true, paperSchedulingAllowed: false,
      reasons: [{ code: "PAIR_RECONCILIATION_MISMATCH" }],
    });
  });

  it("enables paper authority only when both startup reconciliation and complete wiring are healthy", async () => {
    const config = AppConfigSchema.parse({ pair: { paper_execution_enabled: true } });
    const subsystem = await createPairSubsystem(options(config, {
      facadeDependencies: facadeDependencies(),
      isEffectLegal: async () => true,
    }));

    expect(subsystem.startup).toMatchObject({ status: "HEALTHY", paperSchedulingAllowed: true });
    expect(subsystem.authority).toMatchObject({
      observerEnabled: true, paperSchedulingEnabled: true, liveExecutionAvailable: false,
    });
    expect(subsystem.facade).not.toBeNull();
    expect(subsystem.capability).toMatchObject({
      paperSchedulingAllowed: true, facadeConstructed: true, unwiredReasons: [],
    });
    expect(subsystem.healthSnapshot()).toMatchObject({
      status: "HEALTHY", observerAllowed: true, paperSchedulingAllowed: true,
    });
    expect(await subsystem.adapters.groupReads.listActiveGroups()).toEqual([]);
    expect(await subsystem.adapters.reconciliation.reconcile(now + 1)).toEqual({
      inspectedGroupCount: 0, healthyGroupCount: 0, repairedGroupCount: 0,
      pendingGroupCount: 0, manualReviewGroupCount: 0,
    });
  });

  it("validates the full configuration and refuses a config-shaped request for live pair capability", async () => {
    const base = AppConfigSchema.parse({});
    const invalid = { ...base, pair: { ...base.pair, live_execution_enabled: true } } as unknown as AppConfig;
    await expect(createPairSubsystem(options(invalid))).rejects.toBeInstanceOf(PairSubsystemConfigurationError);
  });
});

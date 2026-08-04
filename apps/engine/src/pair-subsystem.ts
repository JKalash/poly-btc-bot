import { validateConfig, type AppConfig } from "@b5p/config";
import { schema, type DbHandle } from "@b5p/db";
import { parseFixed, type Usdc6 } from "@b5p/domain";
import {
  canonicalObjectHash,
  createPairExecution,
  type PairCapabilityAuthority,
  type PairExecution,
  type PairExecutionDependencies,
  type PairGroupId,
  type PairGroupView,
  type PairPortfolioSnapshot,
  type PairReconciliationPort,
} from "@b5p/pair-execution";
import { PairAccountStore } from "./pair-account-store";
import { buildPairHealthView, type PairHealthView } from "./pair-health";
import { PairObservationStore } from "./pair-observation-store";
import { PairObserverEvaluator, type PairObserverBookSource, type PairObserverResult } from "./pair-observer-evaluator";
import type { PairObserverEvaluation } from "./pair-runtime";
import { PairOutboxDispatcher, type PairEffectLegalityCheck } from "./pair-outbox-dispatcher";
import {
  buildPairCapabilityAuthority,
  buildPairObserverOperationalSnapshot,
  type PairObserverOperationalSnapshot,
} from "./pair-policy";
import { PairStartupReconciler, type PairStartupReconciliationResult } from "./pair-startup-reconciliation";
import { ACTIVE_PAIR_GROUP_STATES, PairStore } from "./pair-store";
import {
  ExplicitMetadataFeeConventionResolver,
  PersistedPairTokenTermsProvider,
  type PairTokenTermsSource,
} from "./pair-token-terms";
import { DbPaperPairOperationStore, PaperPairVenue } from "./paper-pair-venue";
import { createAtomicityBlockedPairExecutionDependencies } from "./pair-lifecycle-adapter";

export type PairSubsystemUnwiredReason =
  | "PAIR_EFFECT_LEGALITY_UNWIRED"
  | "PAIR_LIFECYCLE_ATOMICITY_UNAVAILABLE";

export interface PairSubsystemHealthSources {
  readonly captureQueueDepth?: () => number;
  readonly captureQueueOverflowed?: () => boolean;
  readonly captureGapUnbounded?: () => boolean;
  readonly invalidMarketCount?: () => number;
  readonly feeTermsHealthy?: () => boolean;
  readonly constraintTermsHealthy?: () => boolean;
  readonly lastCaptureAtMs?: () => number | null;
  readonly lastFeeSnapshotAtMs?: () => number | null;
  readonly lastConstraintSnapshotAtMs?: () => number | null;
}

export interface CreatePairSubsystemOptions {
  readonly db: DbHandle;
  readonly config: AppConfig;
  readonly configVersion: number;
  readonly sourceVersion: string;
  readonly startupRunKey: string;
  readonly engine: PairObserverBookSource;
  readonly termsSource: PairTokenTermsSource;
  readonly portfolio: (input: { readonly marketId: string; readonly asOfMs: number }) => Promise<PairPortfolioSnapshot>;
  readonly requestedCashCap6: (input: {
    readonly marketId: string;
    readonly portfolio: PairPortfolioSnapshot;
    readonly policy: PairCapabilityAuthority["policy"];
  }) => Usdc6;
  readonly maximumObserverMarkets: number;
  readonly secondsRemaining?: (input: { readonly marketId: string; readonly asOfMs: number }) => number | undefined;
  readonly captureSequence?: (input: PairObserverEvaluation) => bigint;
  readonly nowMs?: () => number;
  readonly onObserverResult?: (result: PairObserverResult) => void;
  readonly onObserverHealth?: (code: string, detail: Readonly<Record<string, unknown>>) => void;
  readonly healthSources?: PairSubsystemHealthSources;
  /** Required before the dispatcher may treat any claimed effect as legal. */
  readonly isEffectLegal?: PairEffectLegalityCheck;
  /**
   * Lifecycle SQL adapters are not complete in BPAIR-080. Callers may inject a
   * complete, already-audited port set; partial/no-op ports are not accepted.
   */
  readonly facadeDependencies?: PairExecutionDependencies;
}

export interface PairSubsystemCapabilitySnapshot {
  readonly observerConfigured: boolean;
  readonly paperSchedulingConfigured: boolean;
  readonly paperSchedulingAllowed: boolean;
  readonly liveExecutionAvailable: false;
  readonly facadeConstructed: boolean;
  readonly unwiredReasons: readonly PairSubsystemUnwiredReason[];
  readonly configVersion: number;
  readonly policyHash: string;
}

export interface PairSubsystem {
  readonly configuredAuthority: PairCapabilityAuthority;
  readonly authority: PairCapabilityAuthority;
  readonly operational: PairObserverOperationalSnapshot;
  readonly startup: PairStartupReconciliationResult;
  readonly capability: PairSubsystemCapabilitySnapshot;
  readonly stores: {
    readonly groups: PairStore;
    readonly accounts: PairAccountStore;
    readonly observations: PairObservationStore;
    readonly paperOperations: DbPaperPairOperationStore;
  };
  readonly terms: PersistedPairTokenTermsProvider;
  readonly observer: PairObserverEvaluator;
  readonly venue: PaperPairVenue;
  readonly dispatcher: PairOutboxDispatcher;
  readonly adapters: {
    readonly groupReads: {
      getGroup(groupId: PairGroupId): Promise<PairGroupView | null>;
      listActiveGroups(): Promise<readonly PairGroupView[]>;
    };
    readonly reconciliation: PairReconciliationPort;
  };
  readonly facade: PairExecution | null;
  healthSnapshot(): PairHealthView;
  refreshHealth(): Promise<PairHealthView>;
}

export class PairSubsystemConfigurationError extends Error {
  override readonly name = "PairSubsystemConfigurationError";
}

function validateOptions(options: CreatePairSubsystemOptions): void {
  const validation = validateConfig(options.config);
  if (!validation.ok) {
    throw new PairSubsystemConfigurationError(validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
  }
  if (!Number.isSafeInteger(options.configVersion) || options.configVersion < 1) {
    throw new PairSubsystemConfigurationError("configVersion must be a positive safe integer");
  }
  if (options.sourceVersion.trim().length === 0 || options.startupRunKey.trim().length === 0) {
    throw new PairSubsystemConfigurationError("sourceVersion and startupRunKey must be non-empty");
  }
  if (!Number.isSafeInteger(options.maximumObserverMarkets) || options.maximumObserverMarkets <= 0) {
    throw new PairSubsystemConfigurationError("maximumObserverMarkets must be a positive safe integer");
  }
}

function effectiveAuthority(
  configured: PairCapabilityAuthority,
  paperSchedulingAllowed: boolean,
): PairCapabilityAuthority {
  const { policyHash: _oldHash, ...base } = configured.policy;
  const policyWithoutHash = Object.freeze({
    ...base,
    paperSchedulingEnabled: configured.paperSchedulingEnabled && paperSchedulingAllowed,
  });
  const policy = Object.freeze({ ...policyWithoutHash, policyHash: canonicalObjectHash(policyWithoutHash) });
  return Object.freeze({
    observerEnabled: configured.observerEnabled,
    paperSchedulingEnabled: policy.paperSchedulingEnabled,
    liveExecutionAvailable: false,
    configVersion: configured.configVersion,
    policy,
  });
}

function groupView(row: typeof schema.pairOrderGroups.$inferSelect): PairGroupView {
  return Object.freeze({
    groupId: row.id as PairGroupId,
    marketId: row.marketId,
    state: row.state,
    halted: row.haltedAtMs !== null,
    activateAtMs: row.activateAtMs,
    nextActionAtMs: row.nextActionAtMs,
    reservedCash6: row.reservedCash6,
    upHeldShares6: row.upHeldShares6,
    downHeldShares6: row.downHeldShares6,
    reconciliationStatus: row.reconciliationStatus as PairGroupView["reconciliationStatus"],
    stateVersion: row.stateVersion,
  });
}

/**
 * Compose the isolated pair observer/paper subsystem. Startup reconciliation
 * always finishes before an authority capable of paper scheduling is exposed.
 */
export async function createPairSubsystem(options: CreatePairSubsystemOptions): Promise<PairSubsystem> {
  validateOptions(options);
  const now = options.nowMs ?? Date.now;
  const configuredAuthority = buildPairCapabilityAuthority(
    options.config,
    options.configVersion,
    options.sourceVersion,
  );
  const operational = buildPairObserverOperationalSnapshot(options.config);
  const groups = new PairStore(options.db);
  const accounts = new PairAccountStore(options.db);
  const observations = new PairObservationStore(options.db);
  const paperOperations = new DbPaperPairOperationStore(options.db);
  const terms = new PersistedPairTokenTermsProvider(
    options.db,
    options.termsSource,
    new ExplicitMetadataFeeConventionResolver(),
    {
      maximumFeeSnapshotAgeMs: configuredAuthority.policy.maximumFeeSnapshotAgeMs,
      maximumConstraintSnapshotAgeMs: configuredAuthority.policy.maximumConstraintSnapshotAgeMs,
      nowMs: now,
    },
  );
  const startupReconciler = new PairStartupReconciler(options.db);
  const startupAtMs = now();
  const startup = await startupReconciler.reconcileStartup({
    runKey: options.startupRunKey,
    nowMs: startupAtMs,
  });

  const unwiredReasons: PairSubsystemUnwiredReason[] = [];
  if (configuredAuthority.paperSchedulingEnabled && options.facadeDependencies === undefined) {
    unwiredReasons.push("PAIR_LIFECYCLE_ATOMICITY_UNAVAILABLE");
  }
  if (configuredAuthority.paperSchedulingEnabled && options.isEffectLegal === undefined) {
    unwiredReasons.push("PAIR_EFFECT_LEGALITY_UNWIRED");
  }
  const paperInfrastructureWired = unwiredReasons.length === 0;
  const schedulingAllowed = configuredAuthority.paperSchedulingEnabled
    && startup.paperSchedulingAllowed
    && paperInfrastructureWired;
  const authority = effectiveAuthority(configuredAuthority, schedulingAllowed);

  let observerEvaluationHealthy = true;
  const observer = new PairObserverEvaluator({
    engine: options.engine,
    terms,
    observations,
    policy: () => authority.policy,
    observerOperationalHash: () => operational.operationalHash,
    portfolio: options.portfolio,
    requestedCashCap6: options.requestedCashCap6,
    secondsRemaining: options.secondsRemaining,
    captureSequence: options.captureSequence,
    prefilterBand6: parseFixed(options.config.pair.prefilter_band_usdc_per_share, 6),
    maximumMarkets: options.maximumObserverMarkets,
    nowMs: now,
    onHealth: (code, detail) => {
      if (code === "PAIR_RUNTIME_EVALUATION_FAILED") observerEvaluationHealthy = false;
      options.onObserverHealth?.(code, detail);
    },
    onResult: options.onObserverResult,
  });
  const venue = new PaperPairVenue(paperOperations, { now });
  const dispatcher = new PairOutboxDispatcher(
    groups,
    venue,
    options.isEffectLegal ?? (async () => false),
  );
  const groupReads = Object.freeze({
    async getGroup(groupId: PairGroupId): Promise<PairGroupView | null> {
      const row = await groups.getGroup(groupId);
      return row === null ? null : groupView(row);
    },
    async listActiveGroups(): Promise<readonly PairGroupView[]> {
      const all = await options.db.db.select().from(schema.pairOrderGroups);
      return Object.freeze(all
        .filter(({ state }) => (ACTIVE_PAIR_GROUP_STATES as readonly string[]).includes(state))
        .map(groupView));
    },
  });
  let reconciliationOrdinal = 0;
  const reconciliation: PairReconciliationPort = Object.freeze({
    async reconcile(nowMs: number) {
      const result = await startupReconciler.reconcileStartup({
        runKey: `${options.startupRunKey}:periodic:${nowMs}:${++reconciliationOrdinal}`,
        nowMs,
      });
      return {
        inspectedGroupCount: result.groups.length,
        healthyGroupCount: result.groups.filter(({ status }) => status === "HEALTHY").length,
        repairedGroupCount: result.groups.filter(({ projectionRebuilt }) => projectionRebuilt).length,
        pendingGroupCount: result.groups.filter(({ status }) => status === "PENDING_OBSERVATION").length,
        manualReviewGroupCount: result.groups.filter(({ status }) => status === "MANUAL_REVIEW").length
          + result.accounts.filter(({ status }) => status === "MANUAL_REVIEW").length,
      };
    },
  });
  const facadeDependencies = options.facadeDependencies ?? createAtomicityBlockedPairExecutionDependencies({
    db: options.db,
    groups,
    reconciliation,
  });
  const facade = createPairExecution(facadeDependencies, authority);

  let rows = await options.db.db.select().from(schema.pairOrderGroups);
  const unknownStates = new Set(["OUTCOME_UNKNOWN", "RECOVERY_OUTCOME_UNKNOWN", "MERGE_OUTCOME_UNKNOWN"]);
  const hs = options.healthSources;
  const healthSnapshot = (): PairHealthView => buildPairHealthView({
    observerEnabled: authority.observerEnabled,
    paperSchedulingEnabled: authority.paperSchedulingEnabled,
    captureQueueDepth: hs?.captureQueueDepth?.() ?? 0,
    captureQueueOverflowed: hs?.captureQueueOverflowed?.() ?? false,
    captureGapUnbounded: hs?.captureGapUnbounded?.() ?? false,
    invalidMarketCount: hs?.invalidMarketCount?.() ?? 0,
    feeTermsHealthy: hs?.feeTermsHealthy?.() ?? true,
    constraintTermsHealthy: hs?.constraintTermsHealthy?.() ?? true,
    reconciliationHealthy: startup.paperSchedulingAllowed,
    observerEvaluationHealthy,
    subsystemWired: paperInfrastructureWired,
    unknownGroupCount: rows.filter(({ state }) => unknownStates.has(state)).length,
    residualGroupCount: rows.filter(({ state }) => state === "RESIDUAL").length,
    manualReviewCount: rows.filter(({ state, reconciliationStatus }) => state === "MANUAL_REVIEW" || reconciliationStatus === "MISMATCH").length,
    lastCaptureAtMs: hs?.lastCaptureAtMs?.() ?? null,
    lastFeeSnapshotAtMs: hs?.lastFeeSnapshotAtMs?.() ?? null,
    lastConstraintSnapshotAtMs: hs?.lastConstraintSnapshotAtMs?.() ?? null,
    lastReconciledAtMs: startupAtMs,
  });
  const capability: PairSubsystemCapabilitySnapshot = Object.freeze({
    observerConfigured: configuredAuthority.observerEnabled,
    paperSchedulingConfigured: configuredAuthority.paperSchedulingEnabled,
    paperSchedulingAllowed: authority.paperSchedulingEnabled,
    liveExecutionAvailable: false,
    facadeConstructed: facade !== null,
    unwiredReasons: Object.freeze(unwiredReasons),
    configVersion: authority.configVersion,
    policyHash: authority.policy.policyHash,
  });
  const refreshHealth = async (): Promise<PairHealthView> => {
    rows = await options.db.db.select().from(schema.pairOrderGroups);
    return healthSnapshot();
  };
  return Object.freeze({
    configuredAuthority,
    authority,
    operational,
    startup,
    capability,
    stores: Object.freeze({ groups, accounts, observations, paperOperations }),
    terms,
    observer,
    venue,
    dispatcher,
    adapters: Object.freeze({ groupReads, reconciliation }),
    facade,
    healthSnapshot,
    refreshHealth,
  });
}

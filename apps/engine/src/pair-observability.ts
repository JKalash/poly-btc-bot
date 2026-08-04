import { buildPairHealthView, PairTelemetry, type PairHealthView, type PairMetricPoint } from "./pair-health";
import type { PairCaptureQueueMetrics } from "./pair-capture-queue";

export interface PairObservabilityCapability {
  readonly observerEnabled: boolean;
  readonly paperExecutionEnabled: boolean;
  readonly liveExecutionAvailable: false;
  readonly strategyVersion: string;
}

export interface PairObservabilityStoreCounts {
  readonly openEpisodes: number;
  readonly activeGroups: number;
  readonly unknownGroups: number;
  readonly residualGroups: number;
  readonly manualReviewGroups: number;
  readonly pairCashAvailable6: bigint;
  readonly pairCashReserved6: bigint;
  readonly currentWorstLoss6: bigint;
}

export interface PairObservabilitySources {
  readonly captureGapUnbounded: boolean;
  readonly captureStale: boolean;
  readonly feeTermsHealthy: boolean;
  readonly constraintTermsHealthy: boolean;
  readonly reconciliationHealthy: boolean;
  readonly observerEvaluationHealthy: boolean;
  readonly subsystemWired: boolean;
  readonly engineHalted: boolean;
  readonly lastCaptureAtMs: number | null;
  readonly lastFeeSnapshotAtMs: number | null;
  readonly lastConstraintSnapshotAtMs: number | null;
  readonly lastReconciledAtMs: number | null;
  readonly unpersistedEventGap: number;
}

export interface PairObservabilitySnapshotInput {
  readonly nowMs: number;
  readonly capability: PairObservabilityCapability;
  readonly captureQueue: PairCaptureQueueMetrics;
  readonly captureQueueCapacity: number;
  readonly runtime: {
    readonly registeredMarkets: number;
    readonly busyMarkets: number;
    readonly pendingMarkets: number;
  };
  readonly sources: PairObservabilitySources;
  readonly store: PairObservabilityStoreCounts;
}

export interface PairCockpitSnapshot {
  readonly generatedAtMs: number;
  readonly banner: Readonly<{
    label: "RESEARCH / COUNTERFACTUAL PAPER ONLY";
    observerEnabled: boolean;
    paperExecutionEnabled: boolean;
    liveExecutionAvailable: false;
    liveExecutionMessage: "LIVE EXECUTION DOES NOT EXIST";
    strategyVersion: string;
  }>;
  readonly health: PairHealthView;
  readonly queue: Readonly<{
    depth: number;
    capacity: number;
    maximumObservedDepth: number;
    unhealthyMarketCount: number;
    overflows: number;
    lastFlushLatencyMs: number | null;
  }>;
  readonly runtime: PairObservabilitySnapshotInput["runtime"];
  readonly current: Readonly<{
    openEpisodes: number;
    activeGroups: number;
    unknownOutcomeGroups: number;
    residualGroups: number;
    manualReviewGroups: number;
    pairCashAvailable6: string;
    pairCashReserved6: string;
    currentWorstLoss6: string;
  }>;
  readonly faults: readonly PairHealthView["reasons"][number][];
  readonly metrics: readonly PairMetricPoint[];
  readonly lastCommittedFactAtMs: number | null;
}

export type PairCommittedObservabilityFact =
  | { readonly commitStatus: "COMMITTED" | "UNCOMMITTED"; readonly factId: string; readonly occurredAtMs: number; readonly kind: "CAPTURE_EVENT"; readonly captureKind: string }
  | { readonly commitStatus: "COMMITTED" | "UNCOMMITTED"; readonly factId: string; readonly occurredAtMs: number; readonly kind: "CAPTURE_FLUSH"; readonly durationMs: number }
  | { readonly commitStatus: "COMMITTED" | "UNCOMMITTED"; readonly factId: string; readonly occurredAtMs: number; readonly kind: "CAPTURE_REJECTION"; readonly code: string }
  | { readonly commitStatus: "COMMITTED" | "UNCOMMITTED"; readonly factId: string; readonly occurredAtMs: number; readonly kind: "OBSERVATION"; readonly observationKind: string; readonly primaryCode: string }
  | { readonly commitStatus: "COMMITTED" | "UNCOMMITTED"; readonly factId: string; readonly occurredAtMs: number; readonly kind: "EPISODE_CLOSED"; readonly closeReason: string; readonly durationMs: number }
  | { readonly commitStatus: "COMMITTED" | "UNCOMMITTED"; readonly factId: string; readonly occurredAtMs: number; readonly kind: "GROUP_TERMINAL"; readonly terminalState: string; readonly dispatchModel: string }
  | { readonly commitStatus: "COMMITTED" | "UNCOMMITTED"; readonly factId: string; readonly occurredAtMs: number; readonly kind: "LEG_OUTCOME"; readonly outcome: string; readonly disposition: string }
  | { readonly commitStatus: "COMMITTED" | "UNCOMMITTED"; readonly factId: string; readonly occurredAtMs: number; readonly kind: "RESIDUAL"; readonly outcome: string }
  | { readonly commitStatus: "COMMITTED" | "UNCOMMITTED"; readonly factId: string; readonly occurredAtMs: number; readonly kind: "RECOVERY"; readonly policy: string; readonly result: string }
  | { readonly commitStatus: "COMMITTED" | "UNCOMMITTED"; readonly factId: string; readonly occurredAtMs: number; readonly kind: "RECONCILIATION"; readonly status: string; readonly durationMs: number }
  | { readonly commitStatus: "COMMITTED" | "UNCOMMITTED"; readonly factId: string; readonly occurredAtMs: number; readonly kind: "PROJECTION_REBUILD" }
  | { readonly commitStatus: "COMMITTED" | "UNCOMMITTED"; readonly factId: string; readonly occurredAtMs: number; readonly kind: "OUTBOX_EFFECT"; readonly action: string; readonly state: string; readonly latencyMs: number }
  | { readonly commitStatus: "COMMITTED" | "UNCOMMITTED"; readonly factId: string; readonly occurredAtMs: number; readonly kind: "INVARIANT_BREACH"; readonly code: string }
  | { readonly commitStatus: "COMMITTED" | "UNCOMMITTED"; readonly factId: string; readonly occurredAtMs: number; readonly kind: "OBSERVER_TIMING"; readonly durationMs: number; readonly bookAgeMs: number; readonly bookSkewMs: number; readonly quoteNetPnl6: bigint }
  | { readonly commitStatus: "COMMITTED" | "UNCOMMITTED"; readonly factId: string; readonly occurredAtMs: number; readonly kind: "ACTIVATION_TIMING"; readonly activationDelayMs: number; readonly interLegDelayMs: number };

export interface PairPostCommitStatusPublication {
  readonly kind: "PAIR_COMMITTED_STATUS_CHANGED";
  readonly occurredAtMs: number;
  readonly factKind: PairCommittedObservabilityFact["kind"];
  readonly metricNames: readonly string[];
}

export interface PairStatusPublisherOptions {
  readonly maximumRememberedFactIds?: number;
  readonly onPostCommit?: (publication: PairPostCommitStatusPublication) => void;
}

const CAPTURE_KINDS = ["snapshot", "delta", "trade", "connection_reset", "envelope_boundary"] as const;
const OUTCOMES = ["UP", "DOWN"] as const;
const DISPATCH_MODELS = ["PARALLEL", "UP_THEN_DOWN", "DOWN_THEN_UP"] as const;
const TERMINAL_STATES = ["RECONCILED_FLAT", "RECONCILED_SETTLED", "NO_INITIAL_FILL", "PAIRED", "RESIDUAL", "MANUAL_REVIEW"] as const;
const LEG_DISPOSITIONS = ["FILLED", "NO_FILL", "REJECTED", "PARTIAL_CANCELED", "UNKNOWN", "CANCELED", "EXPIRED"] as const;
const RECOVERY_POLICIES = ["NO_AUTO_RECOVERY", "PAPER_COMPLETE_MISSING_LEG", "PAPER_LIQUIDATE_FILLED_LEG", "PAPER_MINIMIZE_WORST_LOSS"] as const;
const RECOVERY_RESULTS = ["SKIPPED", "PAIRED", "FLAT", "PARTIAL", "NO_FILL", "REJECTED", "UNKNOWN", "MANUAL_REVIEW"] as const;
const RECONCILIATION_STATUSES = ["HEALTHY", "REPAIRED", "PENDING", "MANUAL_REVIEW", "MISMATCH"] as const;
const OUTBOX_ACTIONS = ["INITIAL_FOK_UP", "INITIAL_FOK_DOWN", "RECOVERY_COMPLETE_MISSING_LEG", "RECOVERY_LIQUIDATE_FILLED_LEG", "PAPER_VIRTUAL_MERGE"] as const;
const OUTBOX_STATES = ["PENDING", "CLAIMED", "SUCCEEDED", "TERMINAL_REJECTED", "OUTCOME_UNKNOWN", "CANCELED_UNCLAIMED", "EXPIRED_UNCLAIMED"] as const;
const STABLE_CODES = [
  "NONE", "OTHER", "PAIR_CAPTURE_QUEUE_OVERFLOW", "PAIR_CAPTURE_GAP_UNBOUNDED", "PAIR_CAPTURE_STALE",
  "PAIR_BOOKS_INVALID", "PAIR_TERMS_STALE", "PAIR_RECONCILIATION_MISMATCH", "PAIR_EFFECT_OUTCOME_UNKNOWN",
  "PAIR_RESIDUAL_EXPOSURE", "PAIR_MANUAL_REVIEW_REQUIRED", "PAIR_ENGINE_HALTED", "PAIR_SUBSYSTEM_UNWIRED",
  "BOOK_CONTINUITY_UNVERIFIED", "BOOK_SOURCE_STALE", "BOOK_RECEIVE_STALE", "FEE_SNAPSHOT_STALE",
  "CONSTRAINT_SNAPSHOT_STALE", "ACTIVATION_DATA_UNAVAILABLE", "INITIAL_FOK_NOT_ALL_OR_ZERO",
  "CAP_INVARIANT_BREACH", "EPISODE_COOLOFF", "MARKET_CLOSED", "NO_LONGER_ELIGIBLE",
] as const;

function bounded(value: string, values: readonly string[]): string {
  return values.includes(value) ? value : "other";
}

function stableCode(value: string): string {
  return (STABLE_CODES as readonly string[]).includes(value) ? value : "OTHER";
}

function nonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative safe integer`);
}

function nonNegativeDuration(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be finite and non-negative`);
  return value;
}

function metricBigint(telemetry: PairTelemetry, value: bigint): number {
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  if (value > maximum) {
    telemetry.increment("pair_metric_value_clamped_total", { direction: "positive" });
    return Number.MAX_SAFE_INTEGER;
  }
  if (value < -maximum) {
    telemetry.increment("pair_metric_value_clamped_total", { direction: "negative" });
    return -Number.MAX_SAFE_INTEGER;
  }
  return Number(value);
}

/** Cohesive read-only status, health, metric, and post-commit publication bridge. */
export class PairStatusPublisher {
  readonly telemetry = new PairTelemetry();
  private readonly maximumRememberedFactIds: number;
  private readonly rememberedFactIds = new Set<string>();
  private readonly factOrder: string[] = [];
  private lastCommittedFactAtMs: number | null = null;

  constructor(private readonly options: PairStatusPublisherOptions = {}) {
    this.maximumRememberedFactIds = options.maximumRememberedFactIds ?? 10_000;
    if (!Number.isSafeInteger(this.maximumRememberedFactIds) || this.maximumRememberedFactIds <= 0) {
      throw new RangeError("maximumRememberedFactIds must be a positive safe integer");
    }
  }

  /** Returns false for uncommitted or duplicate input; neither is published. */
  recordCommittedFact(fact: PairCommittedObservabilityFact): boolean {
    if (fact.commitStatus !== "COMMITTED") return false;
    if (fact.factId.trim().length === 0) throw new TypeError("committed factId must be non-empty");
    nonNegativeInteger(fact.occurredAtMs, "fact occurredAtMs");
    if (this.rememberedFactIds.has(fact.factId)) return false;
    const metricNames = this.recordMetricFact(fact);
    this.rememberedFactIds.add(fact.factId);
    this.factOrder.push(fact.factId);
    if (this.factOrder.length > this.maximumRememberedFactIds) {
      this.rememberedFactIds.delete(this.factOrder.shift()!);
    }
    this.lastCommittedFactAtMs = this.lastCommittedFactAtMs === null
      ? fact.occurredAtMs
      : Math.max(this.lastCommittedFactAtMs, fact.occurredAtMs);
    const publication = Object.freeze({
      kind: "PAIR_COMMITTED_STATUS_CHANGED" as const,
      occurredAtMs: fact.occurredAtMs,
      factKind: fact.kind,
      metricNames: Object.freeze(metricNames),
    });
    try {
      this.options.onPostCommit?.(publication);
    } catch {
      // Best effort only. Durable readers recover from database truth.
      this.telemetry.increment("pair_status_publication_failures_total");
    }
    return true;
  }

  snapshot(input: PairObservabilitySnapshotInput): PairCockpitSnapshot {
    nonNegativeInteger(input.nowMs, "snapshot nowMs");
    for (const [label, value] of [
      ["queue depth", input.captureQueue.depth],
      ["queue capacity", input.captureQueueCapacity],
      ["invalid market count", input.captureQueue.unhealthyMarketCount],
      ["registered markets", input.runtime.registeredMarkets],
      ["busy markets", input.runtime.busyMarkets],
      ["pending markets", input.runtime.pendingMarkets],
      ["open episodes", input.store.openEpisodes],
      ["active groups", input.store.activeGroups],
      ["unknown groups", input.store.unknownGroups],
      ["residual groups", input.store.residualGroups],
      ["manual review groups", input.store.manualReviewGroups],
      ["unpersisted event gap", input.sources.unpersistedEventGap],
    ] as const) nonNegativeInteger(value, label);
    const health = buildPairHealthView({
      observerEnabled: input.capability.observerEnabled,
      paperSchedulingEnabled: input.capability.paperExecutionEnabled,
      captureQueueDepth: input.captureQueue.depth,
      captureQueueOverflowed: input.captureQueue.overflows > 0 && input.captureQueue.unhealthyMarketCount > 0,
      captureGapUnbounded: input.sources.captureGapUnbounded,
      captureStale: input.sources.captureStale,
      invalidMarketCount: input.captureQueue.unhealthyMarketCount,
      feeTermsHealthy: input.sources.feeTermsHealthy,
      constraintTermsHealthy: input.sources.constraintTermsHealthy,
      reconciliationHealthy: input.sources.reconciliationHealthy,
      observerEvaluationHealthy: input.sources.observerEvaluationHealthy,
      engineHalted: input.sources.engineHalted,
      subsystemWired: input.sources.subsystemWired,
      unknownGroupCount: input.store.unknownGroups,
      residualGroupCount: input.store.residualGroups,
      manualReviewCount: input.store.manualReviewGroups,
      lastCaptureAtMs: input.sources.lastCaptureAtMs,
      lastFeeSnapshotAtMs: input.sources.lastFeeSnapshotAtMs,
      lastConstraintSnapshotAtMs: input.sources.lastConstraintSnapshotAtMs,
      lastReconciledAtMs: input.sources.lastReconciledAtMs,
    });
    this.telemetry.gauge("pair_capture_queue_depth", input.captureQueue.depth);
    this.telemetry.gauge("pair_invalid_books", input.captureQueue.unhealthyMarketCount);
    this.telemetry.gauge("pair_open_episodes", input.store.openEpisodes);
    this.telemetry.gauge("pair_active_groups", input.store.activeGroups);
    this.telemetry.gauge("pair_unknown_groups", input.store.unknownGroups);
    this.telemetry.gauge("pair_residual_groups", input.store.residualGroups);
    this.telemetry.gauge("pair_manual_review_groups", input.store.manualReviewGroups);
    this.telemetry.gauge("pair_cash_available6", metricBigint(this.telemetry, input.store.pairCashAvailable6));
    this.telemetry.gauge("pair_cash_reserved6", metricBigint(this.telemetry, input.store.pairCashReserved6));
    this.telemetry.gauge("pair_current_worst_loss6", metricBigint(this.telemetry, input.store.currentWorstLoss6));
    this.telemetry.gauge("pair_unpersisted_event_gap", input.sources.unpersistedEventGap);
    this.telemetry.gauge("pair_runtime_registered_markets", input.runtime.registeredMarkets);
    this.telemetry.gauge("pair_runtime_busy_markets", input.runtime.busyMarkets);
    this.telemetry.gauge("pair_runtime_pending_markets", input.runtime.pendingMarkets);
    return Object.freeze({
      generatedAtMs: input.nowMs,
      banner: Object.freeze({
        label: "RESEARCH / COUNTERFACTUAL PAPER ONLY" as const,
        observerEnabled: input.capability.observerEnabled,
        paperExecutionEnabled: input.capability.paperExecutionEnabled,
        liveExecutionAvailable: false as const,
        liveExecutionMessage: "LIVE EXECUTION DOES NOT EXIST" as const,
        strategyVersion: input.capability.strategyVersion,
      }),
      health,
      queue: Object.freeze({
        depth: input.captureQueue.depth,
        capacity: input.captureQueueCapacity,
        maximumObservedDepth: input.captureQueue.maxDepth,
        unhealthyMarketCount: input.captureQueue.unhealthyMarketCount,
        overflows: input.captureQueue.overflows,
        lastFlushLatencyMs: input.captureQueue.lastFlushLatencyMs,
      }),
      runtime: Object.freeze({ ...input.runtime }),
      current: Object.freeze({
        openEpisodes: input.store.openEpisodes,
        activeGroups: input.store.activeGroups,
        unknownOutcomeGroups: input.store.unknownGroups,
        residualGroups: input.store.residualGroups,
        manualReviewGroups: input.store.manualReviewGroups,
        pairCashAvailable6: input.store.pairCashAvailable6.toString(10),
        pairCashReserved6: input.store.pairCashReserved6.toString(10),
        currentWorstLoss6: input.store.currentWorstLoss6.toString(10),
      }),
      faults: health.reasons,
      metrics: this.telemetry.snapshot(),
      lastCommittedFactAtMs: this.lastCommittedFactAtMs,
    });
  }

  private recordMetricFact(fact: PairCommittedObservabilityFact): string[] {
    switch (fact.kind) {
      case "CAPTURE_EVENT":
        this.telemetry.increment("pair_capture_events_total", { kind: bounded(fact.captureKind, CAPTURE_KINDS) });
        return ["pair_capture_events_total"];
      case "CAPTURE_FLUSH":
        this.telemetry.observe("pair_capture_flush_ms", nonNegativeDuration(fact.durationMs, "capture flush latency"));
        return ["pair_capture_flush_ms"];
      case "CAPTURE_REJECTION":
        this.telemetry.increment("pair_capture_rejections_total", { code: stableCode(fact.code) });
        return ["pair_capture_rejections_total"];
      case "OBSERVATION":
        this.telemetry.increment("pair_observations_total", { kind: bounded(fact.observationKind, ["REJECTED", "ELIGIBLE", "NEGATIVE_CONTROL"]), primary_code: stableCode(fact.primaryCode) });
        return ["pair_observations_total"];
      case "EPISODE_CLOSED":
        this.telemetry.increment("pair_episodes_total", { close_reason: stableCode(fact.closeReason) });
        this.telemetry.observe("pair_episode_duration_ms", nonNegativeDuration(fact.durationMs, "episode duration"));
        return ["pair_episodes_total", "pair_episode_duration_ms"];
      case "GROUP_TERMINAL":
        this.telemetry.increment("pair_groups_total", { terminal_state: bounded(fact.terminalState, TERMINAL_STATES), dispatch_model: bounded(fact.dispatchModel, DISPATCH_MODELS) });
        return ["pair_groups_total"];
      case "LEG_OUTCOME":
        this.telemetry.increment("pair_leg_outcomes_total", { outcome: bounded(fact.outcome, OUTCOMES), disposition: bounded(fact.disposition, LEG_DISPOSITIONS) });
        return ["pair_leg_outcomes_total"];
      case "RESIDUAL":
        this.telemetry.increment("pair_residuals_total", { outcome: bounded(fact.outcome, OUTCOMES) });
        return ["pair_residuals_total"];
      case "RECOVERY":
        this.telemetry.increment("pair_recovery_total", { policy: bounded(fact.policy, RECOVERY_POLICIES), result: bounded(fact.result, RECOVERY_RESULTS) });
        return ["pair_recovery_total"];
      case "RECONCILIATION":
        this.telemetry.increment("pair_reconciliations_total", { status: bounded(fact.status, RECONCILIATION_STATUSES) });
        this.telemetry.observe("pair_reconciliation_duration_ms", nonNegativeDuration(fact.durationMs, "reconciliation duration"));
        return ["pair_reconciliations_total", "pair_reconciliation_duration_ms"];
      case "PROJECTION_REBUILD":
        this.telemetry.increment("pair_projection_rebuilds_total");
        return ["pair_projection_rebuilds_total"];
      case "OUTBOX_EFFECT":
        this.telemetry.increment("pair_outbox_effects_total", { action: bounded(fact.action, OUTBOX_ACTIONS), state: bounded(fact.state, OUTBOX_STATES) });
        this.telemetry.observe("pair_outbox_latency_ms", nonNegativeDuration(fact.latencyMs, "outbox latency"));
        return ["pair_outbox_effects_total", "pair_outbox_latency_ms"];
      case "INVARIANT_BREACH":
        this.telemetry.increment("pair_invariant_breaches_total", { code: stableCode(fact.code) });
        return ["pair_invariant_breaches_total"];
      case "OBSERVER_TIMING":
        this.telemetry.observe("pair_observer_duration_ms", nonNegativeDuration(fact.durationMs, "observer duration"));
        this.telemetry.observe("pair_book_age_ms", nonNegativeDuration(fact.bookAgeMs, "book age"));
        this.telemetry.observe("pair_book_skew_ms", nonNegativeDuration(fact.bookSkewMs, "book skew"));
        this.telemetry.observe("pair_quote_net_pnl6", metricBigint(this.telemetry, fact.quoteNetPnl6));
        return ["pair_observer_duration_ms", "pair_book_age_ms", "pair_book_skew_ms", "pair_quote_net_pnl6"];
      case "ACTIVATION_TIMING":
        this.telemetry.observe("pair_activation_delay_ms", nonNegativeDuration(fact.activationDelayMs, "activation delay"));
        this.telemetry.observe("pair_inter_leg_delay_ms", nonNegativeDuration(fact.interLegDelayMs, "inter-leg delay"));
        return ["pair_activation_delay_ms", "pair_inter_leg_delay_ms"];
    }
  }
}

/** Pair observer telemetry and health projection (spec §23). */

export type PairHealthStatus = "HEALTHY" | "DEGRADED" | "UNHEALTHY";

export type PairHealthReasonCode =
  | "PAIR_CAPTURE_QUEUE_OVERFLOW"
  | "PAIR_CAPTURE_GAP_UNBOUNDED"
  | "PAIR_CAPTURE_STALE"
  | "PAIR_BOOKS_INVALID"
  | "PAIR_TERMS_STALE"
  | "PAIR_RECONCILIATION_MISMATCH"
  | "PAIR_EFFECT_OUTCOME_UNKNOWN"
  | "PAIR_RESIDUAL_EXPOSURE"
  | "PAIR_MANUAL_REVIEW_REQUIRED"
  | "PAIR_OBSERVER_EVALUATION_FAILED"
  | "PAIR_ENGINE_HALTED"
  | "PAIR_SUBSYSTEM_UNWIRED";

export interface PairHealthReason {
  readonly code: PairHealthReasonCode;
  readonly severity: "DEGRADED" | "UNHEALTHY";
  readonly message: string;
}

export interface PairHealthView {
  readonly status: PairHealthStatus;
  readonly observerAllowed: boolean;
  readonly paperSchedulingAllowed: boolean;
  readonly reasons: readonly PairHealthReason[];
  readonly lastCaptureAtMs: number | null;
  readonly lastFeeSnapshotAtMs: number | null;
  readonly lastConstraintSnapshotAtMs: number | null;
  readonly lastReconciledAtMs: number | null;
  readonly captureQueueDepth: number;
  readonly invalidMarketCount: number;
  readonly unknownGroupCount: number;
  readonly residualGroupCount: number;
  readonly manualReviewCount: number;
}

export interface PairHealthInput {
  readonly observerEnabled: boolean;
  readonly paperSchedulingEnabled: boolean;
  readonly captureQueueDepth: number;
  readonly captureQueueOverflowed: boolean;
  readonly captureGapUnbounded: boolean;
  readonly captureStale?: boolean;
  readonly invalidMarketCount: number;
  readonly feeTermsHealthy: boolean;
  readonly constraintTermsHealthy: boolean;
  readonly reconciliationHealthy: boolean;
  readonly observerEvaluationHealthy: boolean;
  readonly engineHalted?: boolean;
  /** False only when paper was requested but required lifecycle ports are absent. */
  readonly subsystemWired?: boolean;
  readonly unknownGroupCount: number;
  readonly residualGroupCount: number;
  readonly manualReviewCount: number;
  readonly lastCaptureAtMs: number | null;
  readonly lastFeeSnapshotAtMs: number | null;
  readonly lastConstraintSnapshotAtMs: number | null;
  readonly lastReconciledAtMs: number | null;
}

function nonNegative(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative safe integer`);
}

/**
 * Builds the read-only health view. Observation is disabled only when its own
 * evidence boundary is unsafe; accounting/effect faults continue observation
 * while always failing paper scheduling closed.
 */
export function buildPairHealthView(input: PairHealthInput): PairHealthView {
  for (const [label, value] of [
    ["captureQueueDepth", input.captureQueueDepth],
    ["invalidMarketCount", input.invalidMarketCount],
    ["unknownGroupCount", input.unknownGroupCount],
    ["residualGroupCount", input.residualGroupCount],
    ["manualReviewCount", input.manualReviewCount],
  ] as const) nonNegative(value, label);

  const reasons: PairHealthReason[] = [];
  const add = (code: PairHealthReasonCode, severity: PairHealthReason["severity"], message: string): void => {
    reasons.push(Object.freeze({ code, severity, message }));
  };
  if (input.captureQueueOverflowed) add("PAIR_CAPTURE_QUEUE_OVERFLOW", "UNHEALTHY", "capture persistence queue overflowed; continuity requires fresh snapshots");
  if (input.captureGapUnbounded) add("PAIR_CAPTURE_GAP_UNBOUNDED", "UNHEALTHY", "capture continuity has an unbounded persistence gap");
  if (input.captureStale === true) add("PAIR_CAPTURE_STALE", "DEGRADED", "the latest committed pair capture is stale");
  if (input.invalidMarketCount > 0) add("PAIR_BOOKS_INVALID", "DEGRADED", `${input.invalidMarketCount} market book pair(s) are excluded from observation`);
  if (!input.feeTermsHealthy || !input.constraintTermsHealthy) add("PAIR_TERMS_STALE", "DEGRADED", "fee or constraint evidence is unavailable or stale");
  if (!input.reconciliationHealthy) add("PAIR_RECONCILIATION_MISMATCH", "UNHEALTHY", "pair account reconciliation is not healthy");
  if (input.unknownGroupCount > 0) add("PAIR_EFFECT_OUTCOME_UNKNOWN", "UNHEALTHY", `${input.unknownGroupCount} group(s) have unresolved effect outcomes`);
  if (input.residualGroupCount > 0) add("PAIR_RESIDUAL_EXPOSURE", "DEGRADED", `${input.residualGroupCount} group(s) retain directional residual inventory`);
  if (input.manualReviewCount > 0) add("PAIR_MANUAL_REVIEW_REQUIRED", "UNHEALTHY", `${input.manualReviewCount} group(s) require manual review`);
  if (!input.observerEvaluationHealthy) add("PAIR_OBSERVER_EVALUATION_FAILED", "UNHEALTHY", "pair observer evaluation is disabled until explicitly recovered");
  if (input.engineHalted === true) add("PAIR_ENGINE_HALTED", "UNHEALTHY", "pair engine halt is active; new paper scheduling is disabled");
  if (input.subsystemWired === false) add("PAIR_SUBSYSTEM_UNWIRED", "UNHEALTHY", "pair paper scheduling ports are not fully wired");

  const status: PairHealthStatus = reasons.some((reason) => reason.severity === "UNHEALTHY")
    ? "UNHEALTHY"
    : reasons.length > 0 ? "DEGRADED" : "HEALTHY";
  const observerEvidenceHealthy = !input.captureQueueOverflowed && !input.captureGapUnbounded && input.observerEvaluationHealthy;
  const observerAllowed = input.observerEnabled && observerEvidenceHealthy;
  const paperSchedulingAllowed = input.paperSchedulingEnabled && input.engineHalted !== true && observerAllowed && reasons.length === 0;
  return Object.freeze({
    status,
    observerAllowed,
    paperSchedulingAllowed,
    reasons: Object.freeze(reasons),
    lastCaptureAtMs: input.lastCaptureAtMs,
    lastFeeSnapshotAtMs: input.lastFeeSnapshotAtMs,
    lastConstraintSnapshotAtMs: input.lastConstraintSnapshotAtMs,
    lastReconciledAtMs: input.lastReconciledAtMs,
    captureQueueDepth: input.captureQueueDepth,
    invalidMarketCount: input.invalidMarketCount,
    unknownGroupCount: input.unknownGroupCount,
    residualGroupCount: input.residualGroupCount,
    manualReviewCount: input.manualReviewCount,
  });
}

export type PairMetricKind = "counter" | "gauge" | "histogram";
export interface PairMetricPoint {
  readonly kind: PairMetricKind;
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
  readonly count?: number;
}

const canonicalLabels = (labels: Readonly<Record<string, string>>): string => Object.entries(labels)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([key, value]) => `${key}=${value}`)
  .join(",");

/** Small dependency-free collector used by the runtime and health read model. */
export class PairTelemetry {
  private readonly counters = new Map<string, { name: string; labels: Readonly<Record<string, string>>; value: number }>();
  private readonly gauges = new Map<string, { name: string; labels: Readonly<Record<string, string>>; value: number }>();
  private readonly histograms = new Map<string, { name: string; labels: Readonly<Record<string, string>>; sum: number; count: number }>();

  increment(name: string, labels: Readonly<Record<string, string>> = {}, amount = 1): void {
    if (!Number.isFinite(amount) || amount < 0) throw new RangeError("counter increment must be finite and non-negative");
    const key = `${name}|${canonicalLabels(labels)}`;
    const prior = this.counters.get(key);
    this.counters.set(key, { name, labels: Object.freeze({ ...labels }), value: (prior?.value ?? 0) + amount });
  }

  gauge(name: string, value: number, labels: Readonly<Record<string, string>> = {}): void {
    if (!Number.isFinite(value)) throw new RangeError("gauge value must be finite");
    this.gauges.set(`${name}|${canonicalLabels(labels)}`, { name, labels: Object.freeze({ ...labels }), value });
  }

  observe(name: string, value: number, labels: Readonly<Record<string, string>> = {}): void {
    if (!Number.isFinite(value) || value < 0) throw new RangeError("histogram observation must be finite and non-negative");
    const key = `${name}|${canonicalLabels(labels)}`;
    const prior = this.histograms.get(key);
    this.histograms.set(key, { name, labels: Object.freeze({ ...labels }), sum: (prior?.sum ?? 0) + value, count: (prior?.count ?? 0) + 1 });
  }

  snapshot(): readonly PairMetricPoint[] {
    const points: PairMetricPoint[] = [];
    for (const item of this.counters.values()) points.push(Object.freeze({ kind: "counter", ...item }));
    for (const item of this.gauges.values()) points.push(Object.freeze({ kind: "gauge", ...item }));
    for (const item of this.histograms.values()) points.push(Object.freeze({ kind: "histogram", name: item.name, labels: item.labels, value: item.sum, count: item.count }));
    return Object.freeze(points.sort((a, b) => `${a.name}|${canonicalLabels(a.labels)}`.localeCompare(`${b.name}|${canonicalLabels(b.labels)}`)));
  }
}

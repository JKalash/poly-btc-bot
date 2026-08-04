import { describe, expect, it } from "vitest";
import { buildPairHealthView, PairTelemetry, type PairHealthInput } from "../src/pair-health";

const healthy = (overrides: Partial<PairHealthInput> = {}): PairHealthInput => ({
  observerEnabled: true, paperSchedulingEnabled: true, captureQueueDepth: 0,
  captureQueueOverflowed: false, captureGapUnbounded: false, invalidMarketCount: 0,
  feeTermsHealthy: true, constraintTermsHealthy: true, reconciliationHealthy: true,
  observerEvaluationHealthy: true, unknownGroupCount: 0, residualGroupCount: 0,
  manualReviewCount: 0, lastCaptureAtMs: 10, lastFeeSnapshotAtMs: 9,
  lastConstraintSnapshotAtMs: 8, lastReconciledAtMs: 7, ...overrides,
});

describe("pair health and telemetry", () => {
  it("allows observation and paper scheduling only in the fully healthy state", () => {
    expect(buildPairHealthView(healthy())).toMatchObject({ status: "HEALTHY", observerAllowed: true, paperSchedulingAllowed: true });
  });

  it("keeps observation available but fails paper scheduling closed for stale terms", () => {
    const view = buildPairHealthView(healthy({ feeTermsHealthy: false }));
    expect(view).toMatchObject({ status: "DEGRADED", observerAllowed: true, paperSchedulingAllowed: false });
    expect(view.reasons.map((reason) => reason.code)).toEqual(["PAIR_TERMS_STALE"]);
  });

  it("excludes invalid books without globally disabling healthy-market observation", () => {
    const view = buildPairHealthView(healthy({ invalidMarketCount: 2 }));
    expect(view).toMatchObject({ status: "DEGRADED", observerAllowed: true, paperSchedulingAllowed: false, invalidMarketCount: 2 });
    expect(view.reasons[0]?.code).toBe("PAIR_BOOKS_INVALID");
  });

  it("disables observation and scheduling after overflow or an unbounded capture gap", () => {
    for (const change of [{ captureQueueOverflowed: true }, { captureGapUnbounded: true }]) {
      const view = buildPairHealthView(healthy(change));
      expect(view).toMatchObject({ status: "UNHEALTHY", observerAllowed: false, paperSchedulingAllowed: false });
    }
  });

  it("continues read-only observation through accounting/effect faults", () => {
    const view = buildPairHealthView(healthy({ reconciliationHealthy: false, unknownGroupCount: 1, residualGroupCount: 1, manualReviewCount: 1 }));
    expect(view).toMatchObject({ status: "UNHEALTHY", observerAllowed: true, paperSchedulingAllowed: false });
    expect(view.reasons.map((reason) => reason.code)).toEqual([
      "PAIR_RECONCILIATION_MISMATCH", "PAIR_EFFECT_OUTCOME_UNKNOWN", "PAIR_RESIDUAL_EXPOSURE", "PAIR_MANUAL_REVIEW_REQUIRED",
    ]);
  });

  it("collects deterministic labeled counters, gauges, and histogram sums", () => {
    const metrics = new PairTelemetry();
    metrics.increment("pair_capture_events_total", { kind: "envelope" });
    metrics.increment("pair_capture_events_total", { kind: "envelope" }, 2);
    metrics.gauge("pair_capture_queue_depth", 4);
    metrics.observe("pair_observer_duration_ms", 2, { mode: "observe" });
    metrics.observe("pair_observer_duration_ms", 3, { mode: "observe" });
    expect(metrics.snapshot()).toEqual([
      { kind: "counter", name: "pair_capture_events_total", labels: { kind: "envelope" }, value: 3 },
      { kind: "gauge", name: "pair_capture_queue_depth", labels: {}, value: 4 },
      { kind: "histogram", name: "pair_observer_duration_ms", labels: { mode: "observe" }, value: 5, count: 2 },
    ]);
  });
});

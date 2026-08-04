import { describe, expect, it, vi } from "vitest";
import {
  PairStatusPublisher,
  type PairCommittedObservabilityFact,
  type PairObservabilitySnapshotInput,
} from "../src/pair-observability";

const now = 1_800_000_000_000;

function input(overrides: Partial<PairObservabilitySnapshotInput> = {}): PairObservabilitySnapshotInput {
  return {
    nowMs: now,
    capability: {
      observerEnabled: true,
      paperExecutionEnabled: true,
      liveExecutionAvailable: false,
      strategyVersion: "complete_set_pair_v0_RESEARCH_ONLY",
    },
    captureQueue: {
      depth: 2, maxDepth: 4, enqueued: 10, flushed: 8, flushes: 2, overflows: 0,
      rejectedWhileUnhealthy: 0, lastFlushLatencyMs: 7, unhealthyMarketCount: 0,
    },
    captureQueueCapacity: 100,
    runtime: { registeredMarkets: 3, busyMarkets: 1, pendingMarkets: 1 },
    sources: {
      captureGapUnbounded: false,
      captureStale: false,
      feeTermsHealthy: true,
      constraintTermsHealthy: true,
      reconciliationHealthy: true,
      observerEvaluationHealthy: true,
      subsystemWired: true,
      engineHalted: false,
      lastCaptureAtMs: now - 1,
      lastFeeSnapshotAtMs: now - 2,
      lastConstraintSnapshotAtMs: now - 3,
      lastReconciledAtMs: now - 4,
      unpersistedEventGap: 0,
    },
    store: {
      openEpisodes: 1,
      activeGroups: 2,
      unknownGroups: 0,
      residualGroups: 0,
      manualReviewGroups: 0,
      pairCashAvailable6: 90_000_000n,
      pairCashReserved6: 10_000_000n,
      currentWorstLoss6: 500_000n,
    },
    ...overrides,
  };
}

function metric(snapshot: ReturnType<PairStatusPublisher["snapshot"]>, name: string) {
  return snapshot.metrics.find((point) => point.name === name);
}

describe("pair observability cockpit bridge", () => {
  it("composes queue, runtime, store, exact balances, health, and Section 23 gauges", () => {
    const publisher = new PairStatusPublisher();
    const snapshot = publisher.snapshot(input());
    expect(snapshot.banner).toEqual({
      label: "RESEARCH / COUNTERFACTUAL PAPER ONLY",
      observerEnabled: true,
      paperExecutionEnabled: true,
      liveExecutionAvailable: false,
      liveExecutionMessage: "LIVE EXECUTION DOES NOT EXIST",
      strategyVersion: "complete_set_pair_v0_RESEARCH_ONLY",
    });
    expect(snapshot.health).toMatchObject({ status: "HEALTHY", observerAllowed: true, paperSchedulingAllowed: true });
    expect(snapshot.queue).toMatchObject({ depth: 2, capacity: 100, maximumObservedDepth: 4, unhealthyMarketCount: 0 });
    expect(snapshot.runtime).toEqual({ registeredMarkets: 3, busyMarkets: 1, pendingMarkets: 1 });
    expect(snapshot.current).toMatchObject({
      openEpisodes: 1, activeGroups: 2, pairCashAvailable6: "90000000",
      pairCashReserved6: "10000000", currentWorstLoss6: "500000",
    });
    expect(metric(snapshot, "pair_capture_queue_depth")).toMatchObject({ kind: "gauge", value: 2 });
    expect(metric(snapshot, "pair_active_groups")).toMatchObject({ kind: "gauge", value: 2 });
    expect(metric(snapshot, "pair_cash_reserved6")).toMatchObject({ kind: "gauge", value: 10_000_000 });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("maps overflow, stale, gap, terms, reconciliation, exposure, manual review, and halt to stable reasons", () => {
    const base = input();
    const snapshot = new PairStatusPublisher().snapshot(input({
      captureQueue: { ...base.captureQueue, overflows: 1, unhealthyMarketCount: 2 },
      sources: {
        ...base.sources,
        captureGapUnbounded: true,
        captureStale: true,
        feeTermsHealthy: false,
        constraintTermsHealthy: false,
        reconciliationHealthy: false,
        engineHalted: true,
      },
      store: { ...base.store, unknownGroups: 2, residualGroups: 3, manualReviewGroups: 1 },
    }));
    expect(snapshot.health).toMatchObject({ status: "UNHEALTHY", observerAllowed: false, paperSchedulingAllowed: false });
    expect(snapshot.faults.map((fault) => [fault.code, fault.severity])).toEqual([
      ["PAIR_CAPTURE_QUEUE_OVERFLOW", "UNHEALTHY"],
      ["PAIR_CAPTURE_GAP_UNBOUNDED", "UNHEALTHY"],
      ["PAIR_CAPTURE_STALE", "DEGRADED"],
      ["PAIR_BOOKS_INVALID", "DEGRADED"],
      ["PAIR_TERMS_STALE", "DEGRADED"],
      ["PAIR_RECONCILIATION_MISMATCH", "UNHEALTHY"],
      ["PAIR_EFFECT_OUTCOME_UNKNOWN", "UNHEALTHY"],
      ["PAIR_RESIDUAL_EXPOSURE", "DEGRADED"],
      ["PAIR_MANUAL_REVIEW_REQUIRED", "UNHEALTHY"],
      ["PAIR_ENGINE_HALTED", "UNHEALTHY"],
    ]);
  });
});

describe("committed-fact metrics and publication", () => {
  it("publishes only committed facts, deduplicates them, and records counters/histograms", () => {
    const onPostCommit = vi.fn();
    const publisher = new PairStatusPublisher({ onPostCommit, maximumRememberedFactIds: 8 });
    const uncommitted: PairCommittedObservabilityFact = {
      commitStatus: "UNCOMMITTED", factId: "fact-uncommitted", occurredAtMs: now,
      kind: "LEG_OUTCOME", outcome: "UP", disposition: "FILLED",
    };
    expect(publisher.recordCommittedFact(uncommitted)).toBe(false);
    expect(onPostCommit).not.toHaveBeenCalled();

    const facts: PairCommittedObservabilityFact[] = [
      { commitStatus: "COMMITTED", factId: "capture", occurredAtMs: now, kind: "CAPTURE_EVENT", captureKind: "snapshot" },
      { commitStatus: "COMMITTED", factId: "flush", occurredAtMs: now + 1, kind: "CAPTURE_FLUSH", durationMs: 7 },
      { commitStatus: "COMMITTED", factId: "leg", occurredAtMs: now + 2, kind: "LEG_OUTCOME", outcome: "UP", disposition: "FILLED" },
      { commitStatus: "COMMITTED", factId: "reconcile", occurredAtMs: now + 3, kind: "RECONCILIATION", status: "HEALTHY", durationMs: 12 },
      { commitStatus: "COMMITTED", factId: "timing", occurredAtMs: now + 4, kind: "OBSERVER_TIMING", durationMs: 3, bookAgeMs: 20, bookSkewMs: 2, quoteNetPnl6: 5_000n },
    ];
    for (const fact of facts) expect(publisher.recordCommittedFact(fact)).toBe(true);
    expect(publisher.recordCommittedFact(facts[0]!)).toBe(false);
    expect(onPostCommit).toHaveBeenCalledTimes(5);
    const snapshot = publisher.snapshot(input());
    expect(snapshot.lastCommittedFactAtMs).toBe(now + 4);
    expect(metric(snapshot, "pair_capture_events_total")).toMatchObject({ kind: "counter", labels: { kind: "snapshot" }, value: 1 });
    expect(metric(snapshot, "pair_capture_flush_ms")).toMatchObject({ kind: "histogram", value: 7, count: 1 });
    expect(metric(snapshot, "pair_leg_outcomes_total")).toMatchObject({ labels: { outcome: "UP", disposition: "FILLED" }, value: 1 });
    expect(metric(snapshot, "pair_reconciliation_duration_ms")).toMatchObject({ value: 12, count: 1 });
    expect(metric(snapshot, "pair_quote_net_pnl6")).toMatchObject({ value: 5_000, count: 1 });
  });

  it("bounds label cardinality and never publishes raw payloads, IDs, or secrets", () => {
    const publications: unknown[] = [];
    const publisher = new PairStatusPublisher({ onPostCommit: (publication) => publications.push(publication) });
    const hostile = {
      commitStatus: "COMMITTED",
      factId: "group-sensitive-id-123",
      occurredAtMs: now,
      kind: "OUTBOX_EFFECT",
      action: "wallet-secret-action-123",
      state: "arbitrary-user-value-456",
      latencyMs: 4,
      payload: { privateKey: "super-secret", rawBook: [1, 2, 3] },
    } as unknown as PairCommittedObservabilityFact;
    expect(publisher.recordCommittedFact(hostile)).toBe(true);
    const snapshot = publisher.snapshot(input());
    expect(metric(snapshot, "pair_outbox_effects_total")).toMatchObject({ labels: { action: "other", state: "other" } });
    const visible = JSON.stringify({ publications, metrics: snapshot.metrics });
    expect(visible).not.toContain("super-secret");
    expect(visible).not.toContain("privateKey");
    expect(visible).not.toContain("rawBook");
    expect(visible).not.toContain("group-sensitive-id-123");
    expect(visible).not.toContain("wallet-secret-action-123");
    expect(visible).not.toContain("arbitrary-user-value-456");
  });

  it("treats post-commit publication as best effort and exposes delivery failure telemetry", () => {
    const publisher = new PairStatusPublisher({ onPostCommit: () => { throw new Error("bus unavailable"); } });
    expect(publisher.recordCommittedFact({
      commitStatus: "COMMITTED", factId: "projection", occurredAtMs: now, kind: "PROJECTION_REBUILD",
    })).toBe(true);
    const snapshot = publisher.snapshot(input());
    expect(metric(snapshot, "pair_projection_rebuilds_total")).toMatchObject({ value: 1 });
    expect(metric(snapshot, "pair_status_publication_failures_total")).toMatchObject({ value: 1 });
  });
});

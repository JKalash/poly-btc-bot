import { describe, expect, it } from "vitest";
import { pairDatasetObjectHash } from "../src/pair-dataset-manifest";
import {
  PAIR_FUNNEL_METRICS,
  PairEpisodeStatisticsError,
  PairPcg32V1,
  computePairEpisodeStatistics,
  pairBootstrapSeed,
  pairFixedSixHalfEven,
  pairWilson95,
  type PairEpisodeStatisticInput,
  type PairFunnelCountInput,
  type PairFunnelMetric,
} from "../src/pair-episode-statistics";
import type { PairScenarioRunRecord } from "../src/pair-scenario-runner";

function scenarioRun(): PairScenarioRunRecord {
  const result = Object.freeze({ fixture: "BOTH_FILL", exact: 900719925474099312345n });
  return Object.freeze({
    scenarioRunId: "pair-scenario-run-test",
    scenarioAccountId: "pair-scenario-account-test",
    scenarioHash: "a".repeat(64),
    result,
    resultHash: pairDatasetObjectHash(result),
  });
}

function episode(index: number, overrides: Partial<PairEpisodeStatisticInput> = {}): PairEpisodeStatisticInput {
  const dayMs = 86_400_000;
  return {
    episodeId: `episode-${index.toString().padStart(4, "0")}`,
    marketId: `market-${index.toString().padStart(4, "0")}`,
    occurredAtMs: index * dayMs + 1_000,
    activationCandidate: true,
    activationDataAvailable: true,
    activationEconomicsSurvived: true,
    initialDisposition: "BOTH_FILLED",
    recoveryAttempted: false,
    recoveryDisposition: null,
    pairedSettlement: true,
    reconciliationMismatch: false,
    realizedPnl6: "10",
    unresolvedWorstCasePnl6: "0",
    worstCaseLoss6: "0",
    peakCapitalAtRisk6: "100",
    durationMs: 100 + index,
    executableNotional6: "1000000",
    sourceBookAgeMs: 10,
    receiveBookAgeMs: 20,
    crossLegSkewMs: 5,
    activationDelayMs: 350,
    interLegDelayMs: 0,
    signalNetPnl6: "20",
    activationNetPnl6: "10",
    ...overrides,
  };
}

function funnelFor(episodes: readonly PairEpisodeStatisticInput[], completeEnvelopes = 0n): PairFunnelCountInput[] {
  const total = BigInt(episodes.length);
  const count = (predicate: (row: PairEpisodeStatisticInput) => boolean) => BigInt(episodes.filter(predicate).length);
  const values = new Map<PairFunnelMetric, readonly [bigint, bigint]>();
  for (const metric of PAIR_FUNNEL_METRICS) values.set(metric, [0n, 0n]);
  const marketCount = BigInt(new Set(episodes.map(({ marketId }) => marketId)).size);
  values.set("MARKETS_OBSERVED", [marketCount, marketCount]);
  values.set("COMPLETE_ENVELOPES_CAPTURED", [completeEnvelopes, completeEnvelopes]);
  values.set("UNIQUE_OPPORTUNITY_EPISODES", [total, total]);
  const candidates = count(({ activationCandidate }) => activationCandidate);
  const dataAvailable = count(({ activationDataAvailable }) => activationDataAvailable);
  values.set("SCHEDULED_ACTIVATION_CANDIDATES", [candidates, total]);
  values.set("ACTIVATION_DATA_AVAILABLE", [dataAvailable, candidates]);
  values.set("ACTIVATION_ECONOMICS_SURVIVED", [count(({ activationEconomicsSurvived }) => activationEconomicsSurvived), dataAvailable]);
  values.set("BOTH_INITIAL_LEGS_FILLED", [count(({ initialDisposition }) => initialDisposition === "BOTH_FILLED"), candidates]);
  values.set("BOTH_INITIAL_LEGS_ZERO_FILLED", [count(({ initialDisposition }) => initialDisposition === "BOTH_ZERO_FILLED"), candidates]);
  values.set("ONE_LEG_RESIDUALS", [count(({ initialDisposition }) => initialDisposition === "ONE_LEG_RESIDUAL"), candidates]);
  values.set("UNKNOWN_OUTCOMES", [count(({ initialDisposition }) => initialDisposition === "UNKNOWN"), candidates]);
  values.set("RECOVERY_ATTEMPTS", [count(({ recoveryAttempted }) => recoveryAttempted), candidates]);
  values.set("RECOVERY_DISPOSITIONS", [count(({ recoveryDisposition }) => recoveryDisposition !== null), candidates]);
  values.set("PAIRED_SETTLEMENTS", [count(({ pairedSettlement }) => pairedSettlement), candidates]);
  values.set("REALIZED_WINS", [count(({ realizedPnl6 }) => realizedPnl6 !== null && BigInt(realizedPnl6) > 0n), total]);
  values.set("REALIZED_LOSSES", [count(({ realizedPnl6 }) => realizedPnl6 !== null && BigInt(realizedPnl6) < 0n), total]);
  values.set("RECONCILIATION_MISMATCHES", [count(({ reconciliationMismatch }) => reconciliationMismatch), total]);
  return PAIR_FUNNEL_METRICS.map((metric) => {
    const [metricCount, denominator] = values.get(metric)!;
    return { metric, count: metricCount, denominator };
  });
}

function compute(episodes: readonly PairEpisodeStatisticInput[], completeEnvelopes = 0n) {
  return computePairEpisodeStatistics({
    runId: "run-1",
    scenarioRun: scenarioRun(),
    funnel: funnelFor(episodes, completeEnvelopes),
    episodes,
  });
}

describe("pair statistics numeric algorithms", () => {
  it("uses fixed six-decimal half-even rounding", () => {
    expect(pairFixedSixHalfEven(1n, 2_000_000n)).toBe("0.000000");
    expect(pairFixedSixHalfEven(3n, 2_000_000n)).toBe("0.000002");
    expect(pairFixedSixHalfEven(-1n, 2_000_000n)).toBe("0.000000");
    expect(pairFixedSixHalfEven(-3n, 2_000_000n)).toBe("-0.000002");
  });

  it("computes deterministic high-precision Wilson intervals", () => {
    expect(pairWilson95(5n, 10n)).toMatchObject({ status: "OK", lower: "0.236593", upper: "0.763407" });
    expect(pairWilson95(0n, 10n)).toMatchObject({ status: "OK", lower: "0.000000", upper: "0.277533" });
    expect(pairWilson95(0n, 0n)).toMatchObject({ status: "NO_DENOMINATOR", lower: null, upper: null });
  });

  it("pins SHA-256 seed material and the PCG32 v1 stream", () => {
    const seed = pairBootstrapSeed({ runId: "run-1", scenarioHash: "a".repeat(64), metricName: "pnl" });
    expect(seed.seedHex).toBe("6e7c9f4fd6d00cbc");
    const random = new PairPcg32V1(seed.seed64);
    expect([random.nextUint32(), random.nextUint32(), random.nextUint32(), random.nextUint32()]).toEqual([
      1663113783, 3675193125, 610337570, 1326668196,
    ]);
  });
});

describe("pair episode statistics", () => {
  it("renders an empty audited corpus without inventing rates or intervals", () => {
    const result = compute([]);

    expect(result.episodeCount).toBe("0");
    expect(result.pnl).toMatchObject({
      conservativeTotalPnl6: "0",
      maximumDrawdown6: "0",
      perEpisode6: null,
      primaryUtcDayBootstrap95: { status: "INSUFFICIENT_SAMPLE", lower: null, upper: null },
    });
    expect(result.funnel.every(({ rate, zeroDenominator }) => rate === null && zeroDenominator)).toBe(true);
    expect(result.distributions.durationMs).toMatchObject({ count: "0", median: null, maximum: null });
    expect(result.pnl.primaryUtcDayBootstrap95.metadata).toMatchObject({ resamples: 10_000, performedResamples: 0 });
    expect(result.promotionSufficiency).toMatchObject({ status: "INSUFFICIENT_SAMPLE", actualUtcDays: "0", actualActivationCandidates: "0" });
  });

  it("audits denominators against episode facts and retains zero-fill failures", () => {
    const episodes = [
      episode(0),
      episode(1, { initialDisposition: "BOTH_ZERO_FILLED", pairedSettlement: false, realizedPnl6: "0" }),
      episode(2, {
        initialDisposition: "ONE_LEG_RESIDUAL", pairedSettlement: false, realizedPnl6: null,
        unresolvedWorstCasePnl6: "-7", recoveryAttempted: true, recoveryDisposition: "HELD",
      }),
    ];
    const result = compute(episodes);
    const zeroFill = result.funnel.find(({ metric }) => metric === "BOTH_INITIAL_LEGS_ZERO_FILLED")!;
    expect(zeroFill).toMatchObject({ count: "1", denominator: "3", rate: "0.333333" });
    expect(result.pnl.unresolvedWorstCasePnl6).toBe("-7");

    const bad = funnelFor(episodes).map((row) => row.metric === "SCHEDULED_ACTIVATION_CANDIDATES" ? { ...row, count: 2n } : row);
    expect(() => computePairEpisodeStatistics({ runId: "run-1", scenarioRun: scenarioRun(), funnel: bad, episodes })).toThrow(/does not match episode facts/);
    const impossible = funnelFor(episodes).map((row) => row.metric === "MARKETS_OBSERVED" ? { ...row, denominator: 2n } : row);
    expect(() => computePairEpisodeStatistics({ runId: "run-1", scenarioRun: scenarioRun(), funnel: impossible, episodes })).toThrow(/count exceeds denominator/);
  });

  it("sorts inputs, clusters by day and market, and never treats envelope ticks as independent", () => {
    const episodes = Array.from({ length: 12 }, (_, index) => episode(index, { realizedPnl6: index % 3 === 0 ? "-5" : "10" }));
    const first = compute(episodes, 120n);
    const shuffled = compute([...episodes].reverse(), 120n);
    const manyTicks = compute(episodes, 120_000n);

    expect(first.canonicalOutput).toBe(shuffled.canonicalOutput);
    expect(first.pnl.primaryUtcDayBootstrap95).toEqual(manyTicks.pnl.primaryUtcDayBootstrap95);
    expect(first.pnl.marketSensitivityBootstrap95).toEqual(manyTicks.pnl.marketSensitivityBootstrap95);
    expect(first.pnl.primaryUtcDayBootstrap95).toMatchObject({ status: "OK", metadata: { clusterUnit: "UTC_DAY", clusterCount: "12", resamples: 10_000, performedResamples: 10_000 } });
    expect(first.pnl.marketSensitivityBootstrap95).toMatchObject({ status: "OK", metadata: { clusterUnit: "MARKET", clusterCount: "12" } });
    expect(first.promotionSufficiency).toMatchObject({ status: "INSUFFICIENT_SAMPLE", actualUtcDays: "12", actualActivationCandidates: "12" });
    expect(first.statisticalUnits).toEqual({
      episode: "UNIQUE_OBSERVER_EPISODE",
      primaryCluster: "UTC_DAY",
      sensitivityCluster: "MARKET",
      rawTicksTreatedAsIndependent: false,
    });
    expect(first.pnl.primaryUtcDayBootstrap95.metadata.metricName).toBe("conservative_total_pnl6_utc_day");
  });

  it("suppresses bootstrap intervals below ten clusters and reports exact drawdown and quantiles", () => {
    const episodes = [
      episode(0, { realizedPnl6: "10", durationMs: 10 }),
      episode(1, { realizedPnl6: "-10", unresolvedWorstCasePnl6: "-10", durationMs: 20 }),
      episode(2, { realizedPnl6: "5", durationMs: 30 }),
    ];
    const result = compute(episodes);

    expect(result.pnl).toMatchObject({ realizedPnl6: "5", unresolvedWorstCasePnl6: "-10", conservativeTotalPnl6: "-5", maximumDrawdown6: "20" });
    expect(result.pnl.primaryUtcDayBootstrap95.status).toBe("INSUFFICIENT_SAMPLE");
    expect(result.distributions.durationMs).toMatchObject({ median: "20.000000", p75: "25.000000", p95: "29.000000", maximum: "30.000000" });
  });

  it("requires both 30 UTC days and 300 activation candidates for sample sufficiency", () => {
    const episodes = Array.from({ length: 300 }, (_, index) => episode(index, {
      occurredAtMs: Math.floor(index / 10) * 86_400_000 + index,
      marketId: `market-${index % 30}`,
    }));
    const result = compute(episodes);

    expect(result.promotionSufficiency).toEqual({
      status: "SUFFICIENT",
      minimumUtcDays: "30",
      actualUtcDays: "30",
      minimumActivationCandidates: "300",
      actualActivationCandidates: "300",
      reasons: [],
    });
  });

  it("rejects duplicate episode identities and tampered scenario results", () => {
    const row = episode(0);
    expect(() => compute([row, row])).toThrow(/duplicate episodeId/);
    const scenario = scenarioRun();
    expect(() => computePairEpisodeStatistics({
      runId: "run-1",
      scenarioRun: { ...scenario, resultHash: "0".repeat(64) },
      funnel: funnelFor([]),
      episodes: [],
    })).toThrow(PairEpisodeStatisticsError);
  });
});

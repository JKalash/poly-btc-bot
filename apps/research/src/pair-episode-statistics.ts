import { createHash } from "node:crypto";
import { canonicalPairDatasetJson, pairDatasetContentHash, pairDatasetObjectHash } from "./pair-dataset-manifest";
import type { PairScenarioRunRecord } from "./pair-scenario-runner";

export const PAIR_EPISODE_STATISTICS_VERSION = "pair_episode_statistics_v1" as const;
export const PAIR_CLUSTER_BOOTSTRAP_VERSION = "bootstrap_v1" as const;
export const PAIR_PCG32_VERSION = "pcg32_v1" as const;
export const PAIR_BOOTSTRAP_RESAMPLES = 10_000 as const;
export const PAIR_BOOTSTRAP_INTERPOLATION = "R7_LINEAR_H_EQUALS_N_MINUS_1_TIMES_P" as const;
export const PAIR_WILSON_VERSION = "wilson_fixed_point_36_v1" as const;

export const PAIR_FUNNEL_METRICS = Object.freeze([
  "MARKETS_OBSERVED",
  "COMPLETE_ENVELOPES_CAPTURED",
  "VALID_SYNCHRONIZED_CAPTURES",
  "PREFILTER_BAND_CAPTURES",
  "GROSS_ASK_SUM_DISLOCATIONS",
  "FULL_DEPTH_EXECUTABLE_DISLOCATIONS",
  "FEE_POSITIVE_OBSERVATIONS",
  "MINIMUM_PNL_SURVIVORS",
  "MINIMUM_RETURN_SURVIVORS",
  "ONE_TICK_STRESS_SURVIVORS",
  "TWO_TICK_STRESS_SURVIVORS",
  "UNIQUE_OPPORTUNITY_EPISODES",
  "SCHEDULED_ACTIVATION_CANDIDATES",
  "ACTIVATION_DATA_AVAILABLE",
  "ACTIVATION_ECONOMICS_SURVIVED",
  "BOTH_INITIAL_LEGS_FILLED",
  "BOTH_INITIAL_LEGS_ZERO_FILLED",
  "ONE_LEG_RESIDUALS",
  "UNKNOWN_OUTCOMES",
  "RECOVERY_ATTEMPTS",
  "RECOVERY_DISPOSITIONS",
  "PAIRED_SETTLEMENTS",
  "REALIZED_WINS",
  "REALIZED_LOSSES",
  "RECONCILIATION_MISMATCHES",
] as const);

export type PairFunnelMetric = typeof PAIR_FUNNEL_METRICS[number];

export interface PairFunnelCountInput {
  readonly metric: PairFunnelMetric;
  readonly count: string | bigint;
  readonly denominator: string | bigint;
}

export type PairEpisodeInitialDisposition = "NOT_DISPATCHED" | "BOTH_FILLED" | "BOTH_ZERO_FILLED" | "ONE_LEG_RESIDUAL" | "UNKNOWN";

export interface PairEpisodeStatisticInput {
  readonly episodeId: string;
  readonly marketId: string;
  readonly occurredAtMs: number;
  readonly activationCandidate: boolean;
  readonly activationDataAvailable: boolean;
  readonly activationEconomicsSurvived: boolean;
  readonly initialDisposition: PairEpisodeInitialDisposition;
  readonly recoveryAttempted: boolean;
  readonly recoveryDisposition: string | null;
  readonly pairedSettlement: boolean;
  readonly reconciliationMismatch: boolean;
  readonly realizedPnl6: string | bigint | null;
  readonly unresolvedWorstCasePnl6: string | bigint;
  readonly worstCaseLoss6: string | bigint;
  readonly peakCapitalAtRisk6: string | bigint;
  readonly durationMs: number;
  readonly executableNotional6: string | bigint;
  readonly sourceBookAgeMs: number | null;
  readonly receiveBookAgeMs: number | null;
  readonly crossLegSkewMs: number | null;
  readonly activationDelayMs: number | null;
  readonly interLegDelayMs: number | null;
  readonly signalNetPnl6: string | bigint | null;
  readonly activationNetPnl6: string | bigint | null;
}

export interface PairWilsonInterval {
  readonly status: "OK" | "NO_DENOMINATOR";
  readonly lower: string | null;
  readonly upper: string | null;
  readonly confidenceLevel: "0.950000";
  readonly algorithmVersion: typeof PAIR_WILSON_VERSION;
  readonly z: "1.959963984540054";
}

export interface PairAuditedFunnelRow {
  readonly metric: PairFunnelMetric;
  readonly count: string;
  readonly denominator: string;
  readonly rate: string | null;
  readonly zeroDenominator: boolean;
  readonly wilson95: PairWilsonInterval;
}

export interface PairDistributionSummary {
  readonly count: string;
  readonly minimum: string | null;
  readonly median: string | null;
  readonly p75: string | null;
  readonly p90: string | null;
  readonly p95: string | null;
  readonly p99: string | null;
  readonly maximum: string | null;
  readonly quantileRule: typeof PAIR_BOOTSTRAP_INTERPOLATION;
}

export interface PairClusterAggregate {
  readonly clusterKey: string;
  readonly episodeCount: string;
  readonly activationCandidateCount: string;
  readonly pnlContribution6: string;
}

export interface PairBootstrapMetadata {
  readonly algorithmVersion: "deterministic_percentile_cluster_bootstrap_v1";
  readonly bootstrapVersion: typeof PAIR_CLUSTER_BOOTSTRAP_VERSION;
  readonly prngVersion: typeof PAIR_PCG32_VERSION;
  readonly resamples: typeof PAIR_BOOTSTRAP_RESAMPLES;
  readonly performedResamples: 0 | typeof PAIR_BOOTSTRAP_RESAMPLES;
  readonly confidenceLevel: "0.950000";
  readonly clusterUnit: "UTC_DAY" | "MARKET";
  readonly clusterCount: string;
  readonly metricName: string;
  readonly seedMaterialFormat: "run_id|scenario_hash|metric_name|bootstrap_v1";
  readonly seedHex: string;
  readonly sortedClusterKeyHash: string;
  readonly interpolationRule: typeof PAIR_BOOTSTRAP_INTERPOLATION;
}

export interface PairBootstrapInterval {
  readonly status: "OK" | "INSUFFICIENT_SAMPLE";
  readonly pointEstimate6: string;
  readonly lower: string | null;
  readonly upper: string | null;
  readonly metadata: PairBootstrapMetadata;
}

export interface PairEpisodeStatisticsResult {
  readonly statisticsVersion: typeof PAIR_EPISODE_STATISTICS_VERSION;
  readonly runId: string;
  readonly scenarioRunId: string;
  readonly scenarioAccountId: string;
  readonly scenarioHash: string;
  readonly scenarioResultHash: string;
  readonly funnel: readonly PairAuditedFunnelRow[];
  readonly episodeCount: string;
  readonly marketCount: string;
  readonly utcDayCount: string;
  readonly statisticalUnits: Readonly<{
    readonly episode: "UNIQUE_OBSERVER_EPISODE";
    readonly primaryCluster: "UTC_DAY";
    readonly sensitivityCluster: "MARKET";
    readonly rawTicksTreatedAsIndependent: false;
  }>;
  readonly marketAggregates: readonly PairClusterAggregate[];
  readonly utcDayAggregates: readonly PairClusterAggregate[];
  readonly pnl: Readonly<{
    readonly realizedPnl6: string;
    readonly unresolvedWorstCasePnl6: string;
    readonly conservativeTotalPnl6: string;
    readonly maximumDrawdown6: string;
    readonly peakCapitalAtRisk6: string;
    readonly perEpisode6: string | null;
    readonly perMarket6: string | null;
    readonly perUtcDay6: string | null;
    readonly primaryUtcDayBootstrap95: PairBootstrapInterval;
    readonly marketSensitivityBootstrap95: PairBootstrapInterval;
  }>;
  readonly distributions: Readonly<Record<string, PairDistributionSummary>>;
  readonly promotionSufficiency: Readonly<{
    readonly status: "SUFFICIENT" | "INSUFFICIENT_SAMPLE";
    readonly minimumUtcDays: "30";
    readonly actualUtcDays: string;
    readonly minimumActivationCandidates: "300";
    readonly actualActivationCandidates: string;
    readonly reasons: readonly string[];
  }>;
  readonly canonicalOutput: string;
  readonly outputHash: string;
}

export class PairEpisodeStatisticsError extends Error {}

const UNSIGNED = /^(?:0|[1-9]\d*)$/;
const SIGNED = /^(?:0|-?[1-9]\d*)$/;
const HASH = /^[0-9a-f]{64}$/;
const MASK_64 = (1n << 64n) - 1n;
const PCG_MULTIPLIER = 6364136223846793005n;
const PCG_INCREMENT = 1442695040888963407n;
const FP_SCALE = 10n ** 36n;
const Z_NUMERATOR = 1_959_963_984_540_054n;
const Z_DENOMINATOR = 1_000_000_000_000_000n;

function identity(value: string, label: string): string {
  if (value.trim().length === 0) throw new PairEpisodeStatisticsError(`${label} must be non-empty`);
  return value;
}

function decimal(value: string | bigint, label: string, signed = false): bigint {
  const text = typeof value === "bigint" ? value.toString(10) : value;
  if (!(signed ? SIGNED : UNSIGNED).test(text)) throw new PairEpisodeStatisticsError(`${label} must be a canonical ${signed ? "signed" : "unsigned"} decimal`);
  return BigInt(text);
}

function safeTime(value: number | null, label: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new PairEpisodeStatisticsError(`${label} must be a non-negative safe integer or null`);
  return value;
}

function roundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new PairEpisodeStatisticsError("rounding denominator must be positive");
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const quotient = absolute / denominator;
  const remainder = absolute % denominator;
  const twice = remainder * 2n;
  const rounded = twice > denominator || (twice === denominator && quotient % 2n === 1n) ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

export function pairFixedSixHalfEven(numerator: bigint, denominator = 1n): string {
  const scaled = roundHalfEven(numerator * 1_000_000n, denominator);
  const negative = scaled < 0n;
  const absolute = negative ? -scaled : scaled;
  return `${negative ? "-" : ""}${absolute / 1_000_000n}.${(absolute % 1_000_000n).toString().padStart(6, "0")}`;
}

function integerSqrt(value: bigint): bigint {
  if (value < 0n) throw new PairEpisodeStatisticsError("square root input must be non-negative");
  if (value < 2n) return value;
  let current = 1n << BigInt(Math.ceil(value.toString(2).length / 2));
  for (;;) {
    const next = (current + value / current) >> 1n;
    if (next >= current) return current;
    current = next;
  }
}

function fpMultiply(left: bigint, right: bigint): bigint { return left * right / FP_SCALE; }
function fpDivide(left: bigint, right: bigint): bigint {
  if (right === 0n) throw new PairEpisodeStatisticsError("fixed-point division by zero");
  return left * FP_SCALE / right;
}

export function pairWilson95(successes: bigint, trials: bigint): PairWilsonInterval {
  if (successes < 0n || trials < 0n || successes > trials) throw new PairEpisodeStatisticsError("Wilson counts require 0 <= successes <= trials");
  if (trials === 0n) return Object.freeze({
    status: "NO_DENOMINATOR", lower: null, upper: null, confidenceLevel: "0.950000",
    algorithmVersion: PAIR_WILSON_VERSION, z: "1.959963984540054",
  });
  const p = successes * FP_SCALE / trials;
  const z = Z_NUMERATOR * FP_SCALE / Z_DENOMINATOR;
  const zSquared = fpMultiply(z, z);
  const denominator = FP_SCALE + zSquared / trials;
  const center = fpDivide(p + zSquared / (2n * trials), denominator);
  const variance = fpMultiply(p, FP_SCALE - p) / trials + zSquared / (4n * trials * trials);
  const root = integerSqrt(variance * FP_SCALE);
  const margin = fpDivide(fpMultiply(z, root), denominator);
  const lower = center > margin ? center - margin : 0n;
  const upper = center + margin < FP_SCALE ? center + margin : FP_SCALE;
  return Object.freeze({
    status: "OK",
    lower: pairFixedSixHalfEven(lower, FP_SCALE),
    upper: pairFixedSixHalfEven(upper, FP_SCALE),
    confidenceLevel: "0.950000",
    algorithmVersion: PAIR_WILSON_VERSION,
    z: "1.959963984540054",
  });
}

/** Repository-local PCG-XSH-RR 64/32 with a fixed odd stream increment. */
export class PairPcg32V1 {
  private state = 0n;

  constructor(seed64: bigint) {
    if (seed64 < 0n || seed64 > MASK_64) throw new PairEpisodeStatisticsError("PCG seed must fit uint64");
    this.nextUint32();
    this.state = (this.state + seed64) & MASK_64;
    this.nextUint32();
  }

  nextUint32(): number {
    const old = this.state;
    this.state = (old * PCG_MULTIPLIER + PCG_INCREMENT) & MASK_64;
    const xorshifted = Number((((old >> 18n) ^ old) >> 27n) & 0xffff_ffffn) >>> 0;
    const rotation = Number(old >> 59n) & 31;
    return ((xorshifted >>> rotation) | (xorshifted << ((-rotation) & 31))) >>> 0;
  }

  uniformIndex(length: number): number {
    if (!Number.isSafeInteger(length) || length <= 0 || length > 0x1_0000_0000) throw new PairEpisodeStatisticsError("PCG index length is invalid");
    const range = 0x1_0000_0000;
    const limit = Math.floor(range / length) * length;
    let value: number;
    do value = this.nextUint32(); while (value >= limit);
    return value % length;
  }
}

export function pairBootstrapSeed(input: { readonly runId: string; readonly scenarioHash: string; readonly metricName: string }): Readonly<{ seedHex: string; seed64: bigint }> {
  const material = `${input.runId}|${input.scenarioHash}|${input.metricName}|${PAIR_CLUSTER_BOOTSTRAP_VERSION}`;
  const hex = createHash("sha256").update(material).digest("hex").slice(0, 16);
  return Object.freeze({ seedHex: hex, seed64: BigInt(`0x${hex}`) });
}

function quantileR7(sorted: readonly bigint[], numerator: bigint, denominator: bigint): string | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return pairFixedSixHalfEven(sorted[0]!);
  const hNumerator = BigInt(sorted.length - 1) * numerator;
  const lowerIndex = Number(hNumerator / denominator);
  const remainder = hNumerator % denominator;
  const lower = sorted[lowerIndex]!;
  const upper = sorted[Math.min(lowerIndex + 1, sorted.length - 1)]!;
  return pairFixedSixHalfEven(lower * (denominator - remainder) + upper * remainder, denominator);
}

function distribution(values: readonly bigint[]): PairDistributionSummary {
  const sorted = [...values].sort((a, b) => a === b ? 0 : a < b ? -1 : 1);
  return Object.freeze({
    count: sorted.length.toString(10),
    minimum: sorted.length === 0 ? null : pairFixedSixHalfEven(sorted[0]!),
    median: quantileR7(sorted, 1n, 2n),
    p75: quantileR7(sorted, 3n, 4n),
    p90: quantileR7(sorted, 9n, 10n),
    p95: quantileR7(sorted, 19n, 20n),
    p99: quantileR7(sorted, 99n, 100n),
    maximum: sorted.length === 0 ? null : pairFixedSixHalfEven(sorted[sorted.length - 1]!),
    quantileRule: PAIR_BOOTSTRAP_INTERPOLATION,
  });
}

interface ParsedEpisode {
  readonly episodeId: string;
  readonly marketId: string;
  readonly occurredAtMs: number;
  readonly utcDay: string;
  readonly activationCandidate: boolean;
  readonly activationDataAvailable: boolean;
  readonly activationEconomicsSurvived: boolean;
  readonly initialDisposition: PairEpisodeInitialDisposition;
  readonly recoveryAttempted: boolean;
  readonly recoveryDisposition: string | null;
  readonly pairedSettlement: boolean;
  readonly reconciliationMismatch: boolean;
  readonly realizedPnl6: bigint | null;
  readonly unresolvedWorstCasePnl6: bigint;
  readonly worstCaseLoss6: bigint;
  readonly peakCapitalAtRisk6: bigint;
  readonly durationMs: number;
  readonly executableNotional6: bigint;
  readonly sourceBookAgeMs: number | null;
  readonly receiveBookAgeMs: number | null;
  readonly crossLegSkewMs: number | null;
  readonly activationDelayMs: number | null;
  readonly interLegDelayMs: number | null;
  readonly signalNetPnl6: bigint | null;
  readonly activationNetPnl6: bigint | null;
  readonly pnlContribution6: bigint;
}

function parseEpisode(input: PairEpisodeStatisticInput): ParsedEpisode {
  identity(input.episodeId, "episodeId");
  identity(input.marketId, "marketId");
  const occurredAtMs = safeTime(input.occurredAtMs, "occurredAtMs")!;
  if (occurredAtMs > 8_640_000_000_000_000) throw new PairEpisodeStatisticsError("occurredAtMs exceeds the supported UTC calendar range");
  if (![input.activationCandidate, input.activationDataAvailable, input.activationEconomicsSurvived, input.recoveryAttempted, input.pairedSettlement, input.reconciliationMismatch]
    .every((value) => typeof value === "boolean")) throw new PairEpisodeStatisticsError(`episode ${input.episodeId} flags must be booleans`);
  if (!["NOT_DISPATCHED", "BOTH_FILLED", "BOTH_ZERO_FILLED", "ONE_LEG_RESIDUAL", "UNKNOWN"].includes(input.initialDisposition)) {
    throw new PairEpisodeStatisticsError(`episode ${input.episodeId} initialDisposition is invalid`);
  }
  if (input.recoveryDisposition !== null && (typeof input.recoveryDisposition !== "string" || input.recoveryDisposition.trim().length === 0)) {
    throw new PairEpisodeStatisticsError(`episode ${input.episodeId} recoveryDisposition is invalid`);
  }
  if (!input.activationCandidate && (input.activationDataAvailable || input.activationEconomicsSurvived || input.initialDisposition !== "NOT_DISPATCHED")) {
    throw new PairEpisodeStatisticsError(`episode ${input.episodeId} has activation facts without a candidate`);
  }
  if (input.activationEconomicsSurvived && !input.activationDataAvailable) throw new PairEpisodeStatisticsError(`episode ${input.episodeId} survived without activation data`);
  if (input.recoveryDisposition !== null && !input.recoveryAttempted) throw new PairEpisodeStatisticsError(`episode ${input.episodeId} has a recovery disposition without an attempt`);
  const realizedPnl6 = input.realizedPnl6 === null ? null : decimal(input.realizedPnl6, "realizedPnl6", true);
  const unresolved = decimal(input.unresolvedWorstCasePnl6, "unresolvedWorstCasePnl6", true);
  if (unresolved > 0n) throw new PairEpisodeStatisticsError("unresolvedWorstCasePnl6 must be non-positive");
  const loss = decimal(input.worstCaseLoss6, "worstCaseLoss6");
  const capital = decimal(input.peakCapitalAtRisk6, "peakCapitalAtRisk6");
  return Object.freeze({
    episodeId: input.episodeId,
    marketId: input.marketId,
    occurredAtMs,
    utcDay: new Date(occurredAtMs).toISOString().slice(0, 10),
    activationCandidate: input.activationCandidate,
    activationDataAvailable: input.activationDataAvailable,
    activationEconomicsSurvived: input.activationEconomicsSurvived,
    initialDisposition: input.initialDisposition,
    recoveryAttempted: input.recoveryAttempted,
    recoveryDisposition: input.recoveryDisposition,
    pairedSettlement: input.pairedSettlement,
    reconciliationMismatch: input.reconciliationMismatch,
    realizedPnl6,
    unresolvedWorstCasePnl6: unresolved,
    worstCaseLoss6: loss,
    peakCapitalAtRisk6: capital,
    durationMs: safeTime(input.durationMs, "durationMs")!,
    executableNotional6: decimal(input.executableNotional6, "executableNotional6"),
    sourceBookAgeMs: safeTime(input.sourceBookAgeMs, "sourceBookAgeMs"),
    receiveBookAgeMs: safeTime(input.receiveBookAgeMs, "receiveBookAgeMs"),
    crossLegSkewMs: safeTime(input.crossLegSkewMs, "crossLegSkewMs"),
    activationDelayMs: safeTime(input.activationDelayMs, "activationDelayMs"),
    interLegDelayMs: safeTime(input.interLegDelayMs, "interLegDelayMs"),
    signalNetPnl6: input.signalNetPnl6 === null ? null : decimal(input.signalNetPnl6, "signalNetPnl6", true),
    activationNetPnl6: input.activationNetPnl6 === null ? null : decimal(input.activationNetPnl6, "activationNetPnl6", true),
    pnlContribution6: (realizedPnl6 ?? 0n) + unresolved,
  });
}

function aggregateClusters(episodes: readonly ParsedEpisode[], unit: "MARKET" | "UTC_DAY"): readonly PairClusterAggregate[] {
  const grouped = new Map<string, ParsedEpisode[]>();
  for (const episode of episodes) {
    const key = unit === "MARKET" ? episode.marketId : episode.utcDay;
    const rows = grouped.get(key) ?? [];
    rows.push(episode);
    grouped.set(key, rows);
  }
  return Object.freeze([...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([clusterKey, rows]) => Object.freeze({
    clusterKey,
    episodeCount: rows.length.toString(10),
    activationCandidateCount: rows.filter(({ activationCandidate }) => activationCandidate).length.toString(10),
    pnlContribution6: rows.reduce((sum, row) => sum + row.pnlContribution6, 0n).toString(10),
  })));
}

function bootstrap(input: {
  readonly runId: string;
  readonly scenarioHash: string;
  readonly metricName: string;
  readonly clusterUnit: "UTC_DAY" | "MARKET";
  readonly clusters: readonly PairClusterAggregate[];
}): PairBootstrapInterval {
  const sorted = [...input.clusters].sort((a, b) => a.clusterKey.localeCompare(b.clusterKey));
  const keys = sorted.map(({ clusterKey }) => clusterKey);
  const values = sorted.map(({ pnlContribution6 }) => BigInt(pnlContribution6));
  const point = values.reduce((sum, value) => sum + value, 0n);
  const seed = pairBootstrapSeed(input);
  const metadata: PairBootstrapMetadata = Object.freeze({
    algorithmVersion: "deterministic_percentile_cluster_bootstrap_v1",
    bootstrapVersion: PAIR_CLUSTER_BOOTSTRAP_VERSION,
    prngVersion: PAIR_PCG32_VERSION,
    resamples: PAIR_BOOTSTRAP_RESAMPLES,
    performedResamples: sorted.length < 10 ? 0 : PAIR_BOOTSTRAP_RESAMPLES,
    confidenceLevel: "0.950000",
    clusterUnit: input.clusterUnit,
    clusterCount: sorted.length.toString(10),
    metricName: input.metricName,
    seedMaterialFormat: "run_id|scenario_hash|metric_name|bootstrap_v1",
    seedHex: seed.seedHex,
    sortedClusterKeyHash: pairDatasetObjectHash(keys),
    interpolationRule: PAIR_BOOTSTRAP_INTERPOLATION,
  });
  if (sorted.length < 10) return Object.freeze({
    status: "INSUFFICIENT_SAMPLE", pointEstimate6: point.toString(10), lower: null, upper: null, metadata,
  });
  const random = new PairPcg32V1(seed.seed64);
  const samples: bigint[] = [];
  for (let iteration = 0; iteration < PAIR_BOOTSTRAP_RESAMPLES; iteration += 1) {
    let total = 0n;
    for (let draw = 0; draw < values.length; draw += 1) total += values[random.uniformIndex(values.length)]!;
    samples.push(total);
  }
  samples.sort((a, b) => a === b ? 0 : a < b ? -1 : 1);
  return Object.freeze({
    status: "OK",
    pointEstimate6: point.toString(10),
    lower: quantileR7(samples, 1n, 40n),
    upper: quantileR7(samples, 39n, 40n),
    metadata,
  });
}

function auditFunnel(rows: readonly PairFunnelCountInput[], episodes: readonly ParsedEpisode[]): readonly PairAuditedFunnelRow[] {
  const byMetric = new Map<PairFunnelMetric, { count: bigint; denominator: bigint }>();
  for (const row of rows) {
    if (!(PAIR_FUNNEL_METRICS as readonly string[]).includes(row.metric)) throw new PairEpisodeStatisticsError(`unknown funnel metric: ${row.metric}`);
    if (byMetric.has(row.metric)) throw new PairEpisodeStatisticsError(`duplicate funnel metric: ${row.metric}`);
    const count = decimal(row.count, `${row.metric}.count`);
    const denominator = decimal(row.denominator, `${row.metric}.denominator`);
    if (count > denominator) throw new PairEpisodeStatisticsError(`${row.metric} count exceeds denominator`);
    byMetric.set(row.metric, { count, denominator });
  }
  if (byMetric.size !== PAIR_FUNNEL_METRICS.length) throw new PairEpisodeStatisticsError("funnel must contain every required metric exactly once");
  const episodeAudits: Partial<Record<PairFunnelMetric, bigint>> = {
    UNIQUE_OPPORTUNITY_EPISODES: BigInt(episodes.length),
    SCHEDULED_ACTIVATION_CANDIDATES: BigInt(episodes.filter(({ activationCandidate }) => activationCandidate).length),
    ACTIVATION_DATA_AVAILABLE: BigInt(episodes.filter(({ activationDataAvailable }) => activationDataAvailable).length),
    ACTIVATION_ECONOMICS_SURVIVED: BigInt(episodes.filter(({ activationEconomicsSurvived }) => activationEconomicsSurvived).length),
    BOTH_INITIAL_LEGS_FILLED: BigInt(episodes.filter(({ initialDisposition }) => initialDisposition === "BOTH_FILLED").length),
    BOTH_INITIAL_LEGS_ZERO_FILLED: BigInt(episodes.filter(({ initialDisposition }) => initialDisposition === "BOTH_ZERO_FILLED").length),
    ONE_LEG_RESIDUALS: BigInt(episodes.filter(({ initialDisposition }) => initialDisposition === "ONE_LEG_RESIDUAL").length),
    UNKNOWN_OUTCOMES: BigInt(episodes.filter(({ initialDisposition }) => initialDisposition === "UNKNOWN").length),
    RECOVERY_ATTEMPTS: BigInt(episodes.filter(({ recoveryAttempted }) => recoveryAttempted).length),
    RECOVERY_DISPOSITIONS: BigInt(episodes.filter(({ recoveryDisposition }) => recoveryDisposition !== null).length),
    PAIRED_SETTLEMENTS: BigInt(episodes.filter(({ pairedSettlement }) => pairedSettlement).length),
    REALIZED_WINS: BigInt(episodes.filter(({ realizedPnl6 }) => realizedPnl6 !== null && realizedPnl6 > 0n).length),
    REALIZED_LOSSES: BigInt(episodes.filter(({ realizedPnl6 }) => realizedPnl6 !== null && realizedPnl6 < 0n).length),
    RECONCILIATION_MISMATCHES: BigInt(episodes.filter(({ reconciliationMismatch }) => reconciliationMismatch).length),
  };
  for (const [metric, expected] of Object.entries(episodeAudits) as [PairFunnelMetric, bigint][]) {
    if (byMetric.get(metric)!.count !== expected) throw new PairEpisodeStatisticsError(`${metric} does not match episode facts`);
  }
  return Object.freeze(PAIR_FUNNEL_METRICS.map((metric) => {
    const row = byMetric.get(metric)!;
    return Object.freeze({
      metric,
      count: row.count.toString(10),
      denominator: row.denominator.toString(10),
      rate: row.denominator === 0n ? null : pairFixedSixHalfEven(row.count, row.denominator),
      zeroDenominator: row.denominator === 0n,
      wilson95: pairWilson95(row.count, row.denominator),
    });
  }));
}

export function computePairEpisodeStatistics(input: {
  readonly runId: string;
  readonly scenarioRun: PairScenarioRunRecord;
  readonly funnel: readonly PairFunnelCountInput[];
  readonly episodes: readonly PairEpisodeStatisticInput[];
}): PairEpisodeStatisticsResult {
  identity(input.runId, "runId");
  identity(input.scenarioRun.scenarioRunId, "scenarioRunId");
  identity(input.scenarioRun.scenarioAccountId, "scenarioAccountId");
  if (!HASH.test(input.scenarioRun.scenarioHash) || !HASH.test(input.scenarioRun.resultHash)
    || pairDatasetObjectHash(input.scenarioRun.result) !== input.scenarioRun.resultHash) {
    throw new PairEpisodeStatisticsError("scenario result/hash mismatch");
  }
  const episodes = input.episodes.map(parseEpisode).sort((a, b) => a.occurredAtMs - b.occurredAtMs || a.marketId.localeCompare(b.marketId) || a.episodeId.localeCompare(b.episodeId));
  if (new Set(episodes.map(({ episodeId }) => episodeId)).size !== episodes.length) throw new PairEpisodeStatisticsError("duplicate episodeId");
  const funnel = auditFunnel(input.funnel, episodes);
  const marketAggregates = aggregateClusters(episodes, "MARKET");
  const utcDayAggregates = aggregateClusters(episodes, "UTC_DAY");
  const realizedPnl6 = episodes.reduce((sum, row) => sum + (row.realizedPnl6 ?? 0n), 0n);
  const unresolvedWorstCasePnl6 = episodes.reduce((sum, row) => sum + row.unresolvedWorstCasePnl6, 0n);
  const conservativeTotalPnl6 = realizedPnl6 + unresolvedWorstCasePnl6;
  let cumulative = 0n;
  let peak = 0n;
  let maximumDrawdown6 = 0n;
  for (const episode of episodes) {
    cumulative += episode.pnlContribution6;
    if (cumulative > peak) peak = cumulative;
    const drawdown = peak - cumulative;
    if (drawdown > maximumDrawdown6) maximumDrawdown6 = drawdown;
  }
  const peakCapitalAtRisk6 = episodes.reduce((maximum, row) => row.peakCapitalAtRisk6 > maximum ? row.peakCapitalAtRisk6 : maximum, 0n);
  const activationCandidates = BigInt(episodes.filter(({ activationCandidate }) => activationCandidate).length);
  const promotionReasons: string[] = [];
  if (utcDayAggregates.length < 30) promotionReasons.push("UTC_DAY_CLUSTERS_BELOW_30");
  if (activationCandidates < 300n) promotionReasons.push("ACTIVATION_CANDIDATES_BELOW_300");
  const distributions = Object.freeze({
    durationMs: distribution(episodes.map(({ durationMs }) => BigInt(durationMs))),
    executableNotional6: distribution(episodes.map(({ executableNotional6 }) => executableNotional6)),
    sourceBookAgeMs: distribution(episodes.flatMap(({ sourceBookAgeMs }) => sourceBookAgeMs === null ? [] : [BigInt(sourceBookAgeMs)])),
    receiveBookAgeMs: distribution(episodes.flatMap(({ receiveBookAgeMs }) => receiveBookAgeMs === null ? [] : [BigInt(receiveBookAgeMs)])),
    crossLegSkewMs: distribution(episodes.flatMap(({ crossLegSkewMs }) => crossLegSkewMs === null ? [] : [BigInt(crossLegSkewMs)])),
    activationDelayMs: distribution(episodes.flatMap(({ activationDelayMs }) => activationDelayMs === null ? [] : [BigInt(activationDelayMs)])),
    interLegDelayMs: distribution(episodes.flatMap(({ interLegDelayMs }) => interLegDelayMs === null ? [] : [BigInt(interLegDelayMs)])),
    signalNetPnl6: distribution(episodes.flatMap(({ signalNetPnl6 }) => signalNetPnl6 === null ? [] : [signalNetPnl6])),
    activationNetPnl6: distribution(episodes.flatMap(({ activationNetPnl6 }) => activationNetPnl6 === null ? [] : [activationNetPnl6])),
    worstCaseLoss6: distribution(episodes.map(({ worstCaseLoss6 }) => worstCaseLoss6)),
    pnlContribution6: distribution(episodes.map(({ pnlContribution6 }) => pnlContribution6)),
  });
  const per = (count: number): string | null => count === 0 ? null : pairFixedSixHalfEven(conservativeTotalPnl6, BigInt(count));
  const material = Object.freeze({
    statisticsVersion: PAIR_EPISODE_STATISTICS_VERSION,
    runId: input.runId,
    scenarioRunId: input.scenarioRun.scenarioRunId,
    scenarioAccountId: input.scenarioRun.scenarioAccountId,
    scenarioHash: input.scenarioRun.scenarioHash,
    scenarioResultHash: input.scenarioRun.resultHash,
    funnel,
    episodeCount: episodes.length.toString(10),
    marketCount: marketAggregates.length.toString(10),
    utcDayCount: utcDayAggregates.length.toString(10),
    statisticalUnits: Object.freeze({
      episode: "UNIQUE_OBSERVER_EPISODE" as const,
      primaryCluster: "UTC_DAY" as const,
      sensitivityCluster: "MARKET" as const,
      rawTicksTreatedAsIndependent: false as const,
    }),
    marketAggregates,
    utcDayAggregates,
    pnl: Object.freeze({
      realizedPnl6: realizedPnl6.toString(10),
      unresolvedWorstCasePnl6: unresolvedWorstCasePnl6.toString(10),
      conservativeTotalPnl6: conservativeTotalPnl6.toString(10),
      maximumDrawdown6: maximumDrawdown6.toString(10),
      peakCapitalAtRisk6: peakCapitalAtRisk6.toString(10),
      perEpisode6: per(episodes.length),
      perMarket6: per(marketAggregates.length),
      perUtcDay6: per(utcDayAggregates.length),
      primaryUtcDayBootstrap95: bootstrap({
        runId: input.runId, scenarioHash: input.scenarioRun.scenarioHash, metricName: "conservative_total_pnl6_utc_day",
        clusterUnit: "UTC_DAY", clusters: utcDayAggregates,
      }),
      marketSensitivityBootstrap95: bootstrap({
        runId: input.runId, scenarioHash: input.scenarioRun.scenarioHash, metricName: "conservative_total_pnl6_market",
        clusterUnit: "MARKET", clusters: marketAggregates,
      }),
    }),
    distributions,
    promotionSufficiency: Object.freeze({
      status: promotionReasons.length === 0 ? "SUFFICIENT" as const : "INSUFFICIENT_SAMPLE" as const,
      minimumUtcDays: "30" as const,
      actualUtcDays: utcDayAggregates.length.toString(10),
      minimumActivationCandidates: "300" as const,
      actualActivationCandidates: activationCandidates.toString(10),
      reasons: Object.freeze(promotionReasons),
    }),
  });
  const canonicalOutput = canonicalPairDatasetJson(material);
  return Object.freeze({ ...material, canonicalOutput, outputHash: pairDatasetContentHash(canonicalOutput) });
}

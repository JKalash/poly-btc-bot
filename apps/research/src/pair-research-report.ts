import { canonicalPairDatasetJson, pairDatasetContentHash, pairDatasetObjectHash, verifyPairDatasetManifest, type PairDatasetManifest } from "./pair-dataset-manifest";
import type { PairMarketReplayResult } from "./pair-market-replay";
import { verifyPairResearchScenarioMatrix, type PairResearchScenario, type PairResearchScenarioMatrix } from "./pair-research-scenario";
import type { PairScenarioMatrixRunResult, PairScenarioRunRecord } from "./pair-scenario-runner";
import type { PairAuditedFunnelRow, PairEpisodeStatisticsResult } from "./pair-episode-statistics";

export const PAIR_RESEARCH_REPORT_VERSION = "pair_research_report_v1" as const;
export type PairPromotionVerdict = "PAPER_ELIGIBLE" | "REMAIN_OBSERVER_ONLY";

export interface PairReportProvenance {
  readonly codeCommit: string;
  readonly strategyVersion: string;
  readonly baseConfigHash: string;
  readonly observerOperationalHash: string;
  readonly paperVenueVersion: string;
}

export interface PairReportPromotionEvidence {
  readonly capturesWithinConfiguredAgeSkew: boolean;
  readonly humanReviewCompleted: boolean;
  readonly unexplainedIntegrityMismatchCount: string | bigint;
  readonly measuredExecutableNotional6: string | bigint;
  readonly operationalCostThreshold6: string | bigint;
}

export interface PairReportDataQualityExclusion {
  readonly code: string;
  readonly count: string | bigint;
  readonly detail: string;
}

export interface PairReportScenarioSummary {
  readonly designCellId: string;
  readonly scenarioHash: string;
  readonly scenarioResultHash: string;
  readonly statisticsHash: string;
  readonly activationLatencyMs: string;
  readonly dispatchModel: PairResearchScenario["dispatchModel"];
  readonly interLegDelayMs: string;
  readonly displayedDepthBps: PairResearchScenario["displayedDepthBps"];
  readonly priceStressTicksPerLeg: string;
  readonly settlementModel: PairResearchScenario["settlementModel"];
  readonly faultFixture: PairResearchScenario["faultFixture"];
  readonly episodeCount: string;
  readonly activationCandidateCount: string;
  readonly conservativeTotalPnl6: string;
  readonly maximumDrawdown6: string;
  readonly primaryLower95: string | null;
  readonly intervalStatus: "OK" | "INSUFFICIENT_SAMPLE";
}

export interface PairPromotionGate {
  readonly gate: string;
  readonly passed: boolean;
  readonly evidence: string;
}

export interface PairResearchReportModel {
  readonly reportVersion: typeof PAIR_RESEARCH_REPORT_VERSION;
  readonly runId: string;
  readonly generatedFromDeterministicInputs: true;
  readonly liveCapability: false;
  readonly verdict: PairPromotionVerdict;
  readonly sections: Readonly<{
    readonly executiveConclusion: Readonly<{ readonly verdict: PairPromotionVerdict; readonly summary: string }>;
    readonly datasetProvenance: Readonly<{
      readonly datasetId: string; readonly datasetHash: string; readonly datasetManifestVersion: string;
      readonly clockModelVersion: string; readonly tieRuleVersion: string; readonly replayOutputHash: string;
      readonly artifactCount: string; readonly provenance: PairReportProvenance;
    }>;
    readonly feeConstraintRegime: Readonly<{
      readonly feeSnapshotHashes: readonly string[]; readonly constraintSnapshotHashes: readonly string[];
      readonly resolutionHashes: readonly string[]; readonly missingFeeSnapshots: boolean; readonly missingConstraintSnapshots: boolean;
    }>;
    readonly funnel: Readonly<{ readonly baselineScenarioHash: string; readonly rows: readonly PairAuditedFunnelRow[] }>;
    readonly episodeDistributions: PairEpisodeStatisticsResult["distributions"];
    readonly latencyDispatchMatrix: readonly PairReportScenarioSummary[];
    readonly depthTickStress: readonly PairReportScenarioSummary[];
    readonly residualRecoveryOutcomes: Readonly<{
      readonly residuals: string; readonly unknownOutcomes: string; readonly recoveryAttempts: string;
      readonly recoveryDispositions: string; readonly pairedSettlements: string;
    }>;
    readonly pnlDrawdown: Readonly<{
      readonly baselineRealizedPnl6: string; readonly baselineUnresolvedWorstCasePnl6: string;
      readonly baselineConservativeTotalPnl6: string; readonly baselineMaximumDrawdown6: string;
      readonly baselinePeakCapitalAtRisk6: string; readonly scenarioSummaries: readonly PairReportScenarioSummary[];
    }>;
    readonly dataQualityExclusions: readonly Readonly<{ readonly code: string; readonly count: string; readonly detail: string }>[];
    readonly sensitivityLimitations: Readonly<{
      readonly primaryCluster: "UTC_DAY"; readonly sensitivityCluster: "MARKET";
      readonly primaryIntervalStatus: string; readonly marketIntervalStatus: string;
      readonly limitations: readonly string[];
    }>;
    readonly promotionGateVerdict: Readonly<{
      readonly verdict: PairPromotionVerdict; readonly liveCapability: false; readonly gates: readonly PairPromotionGate[];
    }>;
    readonly reproduction: Readonly<{
      readonly command: string; readonly datasetHash: string; readonly replayOutputHash: string;
      readonly scenarioMatrixHash: string; readonly scenarioRunOutputHash: string;
      readonly statisticsHashes: readonly string[]; readonly codeCommit: string; readonly baseConfigHash: string;
      readonly observerOperationalHash: string; readonly provenanceHash: string;
      readonly algorithmVersions: readonly string[]; readonly algorithmSetHash: string;
    }>;
  }>;
}

export interface PairResearchReportInput {
  readonly runId: string;
  readonly datasetRoot: string;
  readonly manifest: PairDatasetManifest;
  readonly replay: PairMarketReplayResult;
  readonly scenarioMatrix: PairResearchScenarioMatrix;
  readonly scenarioRun: PairScenarioMatrixRunResult;
  readonly statistics: readonly PairEpisodeStatisticsResult[];
  readonly provenance: PairReportProvenance;
  readonly promotionEvidence: PairReportPromotionEvidence;
  readonly dataQualityExclusions: readonly PairReportDataQualityExclusion[];
  readonly limitations: readonly string[];
  readonly reproductionCommand: string;
}

export class PairResearchReportError extends Error {}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{7,64}$/;
const UNSIGNED = /^(?:0|[1-9]\d*)$/;
const SIGNED_FIXED = /^-?(?:0|[1-9]\d*)\.\d{6}$/;

export function validatePairReportRunId(runId: string): string {
  if (!RUN_ID.test(runId) || runId === "." || runId === "..") throw new PairResearchReportError("runId must be a safe single path identifier");
  return runId;
}

function text(value: string, label: string): string {
  if (value.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(value)) throw new PairResearchReportError(`${label} must be non-empty and contain no control characters`);
  return value;
}

function hash(value: string, label: string): string {
  if (!HASH.test(value)) throw new PairResearchReportError(`${label} must be a SHA-256 hex digest`);
  return value;
}

function unsigned(value: string | bigint, label: string): bigint {
  const decimal = typeof value === "bigint" ? value.toString(10) : value;
  if (!UNSIGNED.test(decimal)) throw new PairResearchReportError(`${label} must be a canonical unsigned decimal`);
  return BigInt(decimal);
}

function verifyReplay(replay: PairMarketReplayResult): void {
  const material = {
    datasetHash: replay.datasetHash, clockModelVersion: replay.clockModelVersion, tieRuleVersion: replay.tieRuleVersion,
    records: replay.records, finalBooks: replay.finalBooks,
  } as const;
  if (canonicalPairDatasetJson(material) !== replay.canonicalOutput || pairDatasetContentHash(replay.canonicalOutput) !== replay.outputHash) {
    throw new PairResearchReportError("replay canonical output/hash mismatch");
  }
}

function verifyScenarioRun(run: PairScenarioMatrixRunResult): void {
  const material = {
    runNamespace: run.runNamespace, accountNamespace: run.accountNamespace, datasetHash: run.datasetHash,
    replayOutputHash: run.replayOutputHash, matrixHash: run.matrixHash, scenarioRuns: run.scenarioRuns,
  } as const;
  if (canonicalPairDatasetJson(material) !== run.canonicalOutput || pairDatasetContentHash(run.canonicalOutput) !== run.outputHash) {
    throw new PairResearchReportError("scenario run canonical output/hash mismatch");
  }
  for (const scenario of run.scenarioRuns) {
    if (pairDatasetContentHash(canonicalPairDatasetJson(scenario.result)) !== scenario.resultHash) {
      throw new PairResearchReportError(`scenario result hash mismatch: ${scenario.scenarioRunId}`);
    }
  }
}

function verifyStatistics(statistics: PairEpisodeStatisticsResult): void {
  const { canonicalOutput, outputHash, ...material } = statistics;
  if (canonicalPairDatasetJson(material) !== canonicalOutput || pairDatasetContentHash(canonicalOutput) !== outputHash) {
    throw new PairResearchReportError(`statistics canonical output/hash mismatch: ${statistics.scenarioRunId}`);
  }
}

function funnelCount(rows: readonly PairAuditedFunnelRow[], metric: PairAuditedFunnelRow["metric"]): bigint {
  const value = rows.find((row) => row.metric === metric);
  if (value === undefined || !UNSIGNED.test(value.count)) throw new PairResearchReportError(`missing funnel metric: ${metric}`);
  return BigInt(value.count);
}

function positiveFixed(value: string | null): boolean {
  if (value === null || !SIGNED_FIXED.test(value)) return false;
  return BigInt(value.replace(".", "")) > 0n;
}

function scenarioSummary(scenario: PairResearchScenario, run: PairScenarioRunRecord, stats: PairEpisodeStatisticsResult): PairReportScenarioSummary {
  const candidates = stats.funnel.find(({ metric }) => metric === "SCHEDULED_ACTIVATION_CANDIDATES")?.count;
  if (candidates === undefined) throw new PairResearchReportError(`scenario statistics lack activation candidates: ${scenario.designCellId}`);
  return Object.freeze({
    designCellId: scenario.designCellId,
    scenarioHash: scenario.scenarioHash,
    scenarioResultHash: run.resultHash,
    statisticsHash: stats.outputHash,
    activationLatencyMs: scenario.activationLatencyMs.toString(10),
    dispatchModel: scenario.dispatchModel,
    interLegDelayMs: scenario.interLegDelayMs.toString(10),
    displayedDepthBps: scenario.displayedDepthBps,
    priceStressTicksPerLeg: scenario.priceStressTicksPerLeg.toString(10),
    settlementModel: scenario.settlementModel,
    faultFixture: scenario.faultFixture,
    episodeCount: stats.episodeCount,
    activationCandidateCount: candidates,
    conservativeTotalPnl6: stats.pnl.conservativeTotalPnl6,
    maximumDrawdown6: stats.pnl.maximumDrawdown6,
    primaryLower95: stats.pnl.primaryUtcDayBootstrap95.lower,
    intervalStatus: stats.pnl.primaryUtcDayBootstrap95.status,
  });
}

export async function buildPairResearchReport(input: PairResearchReportInput): Promise<PairResearchReportModel> {
  const runId = validatePairReportRunId(input.runId);
  await verifyPairDatasetManifest(input.datasetRoot, input.manifest);
  verifyReplay(input.replay);
  const matrix = verifyPairResearchScenarioMatrix(input.scenarioMatrix);
  verifyScenarioRun(input.scenarioRun);
  if (input.replay.datasetHash !== input.manifest.datasetHash || input.scenarioRun.datasetHash !== input.manifest.datasetHash
    || input.scenarioRun.replayOutputHash !== input.replay.outputHash || input.scenarioRun.matrixHash !== matrix.matrixHash) {
    throw new PairResearchReportError("manifest/replay/scenario lineage mismatch");
  }
  const runByHash = new Map(input.scenarioRun.scenarioRuns.map((run) => [run.scenarioHash, run]));
  const statsByRun = new Map<string, PairEpisodeStatisticsResult>();
  for (const stats of input.statistics) {
    verifyStatistics(stats);
    if (stats.runId !== runId || statsByRun.has(stats.scenarioRunId)) throw new PairResearchReportError("statistics run identity is missing, duplicated, or mismatched");
    statsByRun.set(stats.scenarioRunId, stats);
  }
  const summaries = matrix.scenarios.map((scenario) => {
    const run = runByHash.get(scenario.scenarioHash);
    const stats = run === undefined ? undefined : statsByRun.get(run.scenarioRunId);
    if (run === undefined || stats === undefined || stats.scenarioHash !== scenario.scenarioHash
      || stats.scenarioResultHash !== run.resultHash || stats.scenarioAccountId !== run.scenarioAccountId) {
      throw new PairResearchReportError(`missing or mismatched scenario statistics: ${scenario.designCellId}`);
    }
    return scenarioSummary(scenario, run, stats);
  });
  if (summaries.length !== input.scenarioRun.scenarioRuns.length || summaries.length !== input.statistics.length) {
    throw new PairResearchReportError("scenario/statistics coverage must be exact");
  }
  const baselineScenario = matrix.scenarios.find(({ designCellId }) => designCellId === "baseline")!;
  const baselineRun = runByHash.get(baselineScenario.scenarioHash)!;
  const baselineStats = statsByRun.get(baselineRun.scenarioRunId)!;
  const baselineSummary = summaries.find(({ designCellId }) => designCellId === "baseline")!;
  const exclusions = input.dataQualityExclusions.map((entry) => Object.freeze({
    code: text(entry.code, "exclusion code"), count: unsigned(entry.count, `${entry.code}.count`).toString(10), detail: text(entry.detail, `${entry.code}.detail`),
  })).sort((a, b) => a.code.localeCompare(b.code));
  if (new Set(exclusions.map(({ code }) => code)).size !== exclusions.length) throw new PairResearchReportError("duplicate data-quality exclusion code");
  const provenance: PairReportProvenance = Object.freeze({
    codeCommit: COMMIT.test(input.provenance.codeCommit) ? input.provenance.codeCommit : (() => { throw new PairResearchReportError("codeCommit is invalid"); })(),
    strategyVersion: text(input.provenance.strategyVersion, "strategyVersion"),
    baseConfigHash: hash(input.provenance.baseConfigHash, "baseConfigHash"),
    observerOperationalHash: hash(input.provenance.observerOperationalHash, "observerOperationalHash"),
    paperVenueVersion: text(input.provenance.paperVenueVersion, "paperVenueVersion"),
  });
  const feeSnapshotHashes = input.manifest.artifacts.filter(({ role }) => role === "FEE_SNAPSHOTS").map(({ sha256 }) => sha256).sort();
  const constraintSnapshotHashes = input.manifest.artifacts.filter(({ role }) => role === "CONSTRAINT_SNAPSHOTS").map(({ sha256 }) => sha256).sort();
  const resolutionHashes = input.manifest.artifacts.filter(({ role }) => role === "RESOLUTIONS").map(({ sha256 }) => sha256).sort();
  const serialUp = summaries.filter(({ dispatchModel }) => dispatchModel === "UP_THEN_DOWN");
  const serialDown = summaries.filter(({ dispatchModel }) => dispatchModel === "DOWN_THEN_UP");
  const defaultAndP95 = ["baseline", "latency_2x_p95"].map((cell) => summaries.find(({ designCellId }) => designCellId === cell));
  const oneTick = summaries.find(({ designCellId }) => designCellId === "stress_1tick");
  const reconciliationMismatches = input.statistics.reduce((sum, stats) => sum + funnelCount(stats.funnel, "RECONCILIATION_MISMATCHES"), 0n);
  const unexplainedIntegrityMismatchCount = unsigned(input.promotionEvidence.unexplainedIntegrityMismatchCount, "unexplainedIntegrityMismatchCount");
  const measuredNotional6 = unsigned(input.promotionEvidence.measuredExecutableNotional6, "measuredExecutableNotional6");
  const threshold6 = unsigned(input.promotionEvidence.operationalCostThreshold6, "operationalCostThreshold6");
  const gates: PairPromotionGate[] = [
    { gate: "GATE_01_SAMPLE_SUFFICIENCY", passed: baselineStats.promotionSufficiency.status === "SUFFICIENT", evidence: `${baselineStats.promotionSufficiency.actualUtcDays} UTC days; ${baselineStats.promotionSufficiency.actualActivationCandidates} activation candidates` },
    { gate: "GATE_02_DATA_INTEGRITY", passed: reconciliationMismatches === 0n && unexplainedIntegrityMismatchCount === 0n && feeSnapshotHashes.length > 0 && constraintSnapshotHashes.length > 0, evidence: `${reconciliationMismatches} reconciliation mismatches; ${unexplainedIntegrityMismatchCount} unexplained integrity mismatches; ${feeSnapshotHashes.length} fee and ${constraintSnapshotHashes.length} constraint snapshots` },
    { gate: "GATE_03_POSITIVE_TOTAL_NET_PNL", passed: BigInt(baselineSummary.conservativeTotalPnl6) > 0n, evidence: `${baselineSummary.conservativeTotalPnl6} conservative pnl6` },
    { gate: "GATE_04_POSITIVE_CLUSTERED_LOWER_BOUND", passed: positiveFixed(baselineSummary.primaryLower95), evidence: baselineSummary.primaryLower95 ?? "INSUFFICIENT_SAMPLE" },
    { gate: "GATE_05_BOTH_SERIAL_ORDERS_POSITIVE", passed: serialUp.length > 0 && serialDown.length > 0 && [...serialUp, ...serialDown].every(({ conservativeTotalPnl6 }) => BigInt(conservativeTotalPnl6) > 0n), evidence: `${serialUp.length} UP-first and ${serialDown.length} DOWN-first comparisons` },
    { gate: "GATE_06_DEFAULT_AND_2X_P95_POSITIVE", passed: defaultAndP95.every((row) => row !== undefined && BigInt(row.conservativeTotalPnl6) > 0n), evidence: defaultAndP95.map((row) => row === undefined ? "MISSING" : `${row.designCellId}:${row.conservativeTotalPnl6}`).join(", ") },
    { gate: "GATE_07_CAPTURE_AGE_SKEW", passed: input.promotionEvidence.capturesWithinConfiguredAgeSkew === true, evidence: input.promotionEvidence.capturesWithinConfiguredAgeSkew ? "all eligible captures within configured age/skew" : "age/skew evidence failed or missing" },
    { gate: "GATE_08_ONE_TICK_STRESS_POSITIVE", passed: oneTick !== undefined && BigInt(oneTick.conservativeTotalPnl6) > 0n, evidence: oneTick === undefined ? "MISSING" : oneTick.conservativeTotalPnl6 },
    { gate: "GATE_09_OPERATIONAL_NOTIONAL", passed: measuredNotional6 > threshold6, evidence: `${measuredNotional6} measured notional6 vs ${threshold6} threshold6` },
    { gate: "GATE_10_HUMAN_REVIEW", passed: input.promotionEvidence.humanReviewCompleted === true, evidence: input.promotionEvidence.humanReviewCompleted ? "completed" : "not completed" },
  ].map((gate) => Object.freeze(gate));
  const verdict: PairPromotionVerdict = gates.every(({ passed }) => passed) ? "PAPER_ELIGIBLE" : "REMAIN_OBSERVER_ONLY";
  const algorithmVersions = [...new Set(input.statistics.flatMap((stats) => [
    stats.statisticsVersion,
    stats.pnl.primaryUtcDayBootstrap95.metadata.algorithmVersion,
    stats.pnl.primaryUtcDayBootstrap95.metadata.prngVersion,
    stats.pnl.primaryUtcDayBootstrap95.metadata.interpolationRule,
    ...stats.funnel.map(({ wilson95 }) => wilson95.algorithmVersion),
  ]))].sort();
  const row = (metric: PairAuditedFunnelRow["metric"]): string => baselineStats.funnel.find((item) => item.metric === metric)!.count;
  const scenarioRows = Object.freeze(summaries);
  const sections: PairResearchReportModel["sections"] = Object.freeze({
    executiveConclusion: Object.freeze({ verdict, summary: verdict === "PAPER_ELIGIBLE" ? "All research gates passed for reviewed paper scheduling only." : "One or more research gates failed; remain observer-only." }),
    datasetProvenance: Object.freeze({
      datasetId: input.manifest.datasetId, datasetHash: input.manifest.datasetHash,
      datasetManifestVersion: input.manifest.datasetManifestVersion.toString(10), clockModelVersion: input.manifest.clockModelVersion,
      tieRuleVersion: input.manifest.tieRuleVersion, replayOutputHash: input.replay.outputHash,
      artifactCount: input.manifest.artifacts.length.toString(10), provenance,
    }),
    feeConstraintRegime: Object.freeze({ feeSnapshotHashes: Object.freeze(feeSnapshotHashes), constraintSnapshotHashes: Object.freeze(constraintSnapshotHashes), resolutionHashes: Object.freeze(resolutionHashes), missingFeeSnapshots: feeSnapshotHashes.length === 0, missingConstraintSnapshots: constraintSnapshotHashes.length === 0 }),
    funnel: Object.freeze({ baselineScenarioHash: baselineScenario.scenarioHash, rows: baselineStats.funnel }),
    episodeDistributions: baselineStats.distributions,
    latencyDispatchMatrix: Object.freeze(scenarioRows.filter(({ designCellId }) => designCellId === "baseline" || designCellId.startsWith("latency_") || designCellId.startsWith("dispatch_"))),
    depthTickStress: Object.freeze(scenarioRows.filter(({ designCellId }) => designCellId === "baseline" || designCellId.startsWith("depth_") || designCellId.startsWith("stress_"))),
    residualRecoveryOutcomes: Object.freeze({ residuals: row("ONE_LEG_RESIDUALS"), unknownOutcomes: row("UNKNOWN_OUTCOMES"), recoveryAttempts: row("RECOVERY_ATTEMPTS"), recoveryDispositions: row("RECOVERY_DISPOSITIONS"), pairedSettlements: row("PAIRED_SETTLEMENTS") }),
    pnlDrawdown: Object.freeze({ baselineRealizedPnl6: baselineStats.pnl.realizedPnl6, baselineUnresolvedWorstCasePnl6: baselineStats.pnl.unresolvedWorstCasePnl6, baselineConservativeTotalPnl6: baselineStats.pnl.conservativeTotalPnl6, baselineMaximumDrawdown6: baselineStats.pnl.maximumDrawdown6, baselinePeakCapitalAtRisk6: baselineStats.pnl.peakCapitalAtRisk6, scenarioSummaries: scenarioRows }),
    dataQualityExclusions: Object.freeze(exclusions),
    sensitivityLimitations: Object.freeze({ primaryCluster: "UTC_DAY", sensitivityCluster: "MARKET", primaryIntervalStatus: baselineStats.pnl.primaryUtcDayBootstrap95.status, marketIntervalStatus: baselineStats.pnl.marketSensitivityBootstrap95.status, limitations: Object.freeze([...input.limitations].map((value) => text(value, "limitation")).sort()) }),
    promotionGateVerdict: Object.freeze({ verdict, liveCapability: false, gates: Object.freeze(gates) }),
    reproduction: Object.freeze({
      command: text(input.reproductionCommand, "reproductionCommand"), datasetHash: input.manifest.datasetHash,
      replayOutputHash: input.replay.outputHash, scenarioMatrixHash: matrix.matrixHash,
      scenarioRunOutputHash: input.scenarioRun.outputHash, statisticsHashes: Object.freeze(input.statistics.map(({ outputHash }) => outputHash).sort()),
      codeCommit: provenance.codeCommit, baseConfigHash: provenance.baseConfigHash, observerOperationalHash: provenance.observerOperationalHash,
      provenanceHash: pairDatasetObjectHash(provenance),
      algorithmVersions: Object.freeze(algorithmVersions), algorithmSetHash: pairDatasetObjectHash(algorithmVersions),
    }),
  });
  return Object.freeze({ reportVersion: PAIR_RESEARCH_REPORT_VERSION, runId, generatedFromDeterministicInputs: true, liveCapability: false, verdict, sections });
}

function markdown(value: string): string { return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|"); }

function scenarioTable(rows: readonly PairReportScenarioSummary[]): string[] {
  const lines = ["| Cell | Dispatch | Latency ms | Inter-leg ms | Depth bps | Stress ticks | PnL6 | Lower 95% |", "|---|---:|---:|---:|---:|---:|---:|---:|"];
  for (const row of rows) lines.push(`| ${markdown(row.designCellId)} | ${row.dispatchModel} | ${row.activationLatencyMs} | ${row.interLegDelayMs} | ${row.displayedDepthBps} | ${row.priceStressTicksPerLeg} | ${row.conservativeTotalPnl6} | ${row.primaryLower95 ?? row.intervalStatus} |`);
  return lines;
}

export function renderPairResearchReportMarkdown(report: PairResearchReportModel): string {
  const s = report.sections;
  const lines: string[] = [
    `# Pair research report: ${markdown(report.runId)}`,
    "",
    "## 1. Executive conclusion",
    "",
    `**${report.verdict}** — ${s.executiveConclusion.summary}`,
    "",
    "Live capability: **DOES NOT EXIST**.",
    "",
    "## 2. Dataset and provenance",
    "",
    `- Dataset ID: \`${markdown(s.datasetProvenance.datasetId)}\``,
    `- Dataset hash: \`${s.datasetProvenance.datasetHash}\``,
    `- Replay output hash: \`${s.datasetProvenance.replayOutputHash}\``,
    `- Clock/tie versions: \`${s.datasetProvenance.clockModelVersion}\` / \`${s.datasetProvenance.tieRuleVersion}\``,
    `- Code commit: \`${s.datasetProvenance.provenance.codeCommit}\``,
    `- Strategy / paper venue: \`${markdown(s.datasetProvenance.provenance.strategyVersion)}\` / \`${markdown(s.datasetProvenance.provenance.paperVenueVersion)}\``,
    "",
    "## 3. Fee and constraint regime",
    "",
    `- Fee snapshot hashes: ${s.feeConstraintRegime.feeSnapshotHashes.length === 0 ? "MISSING" : s.feeConstraintRegime.feeSnapshotHashes.map((v) => `\`${v}\``).join(", ")}`,
    `- Constraint snapshot hashes: ${s.feeConstraintRegime.constraintSnapshotHashes.length === 0 ? "MISSING" : s.feeConstraintRegime.constraintSnapshotHashes.map((v) => `\`${v}\``).join(", ")}`,
    `- Resolution hashes: ${s.feeConstraintRegime.resolutionHashes.length === 0 ? "none" : s.feeConstraintRegime.resolutionHashes.map((v) => `\`${v}\``).join(", ")}`,
    "",
    "## 4. Funnel",
    "",
    "| Metric | Count | Denominator | Rate |",
    "|---|---:|---:|---:|",
  ];
  for (const row of s.funnel.rows) lines.push(`| ${row.metric} | ${row.count} | ${row.denominator} | ${row.rate ?? "N/A"} |`);
  lines.push("", "## 5. Episode distributions", "", "| Metric | N | Median | P75 | P90 | P95 | P99 | Max |", "|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const [name, value] of Object.entries(s.episodeDistributions).sort(([a], [b]) => a.localeCompare(b))) lines.push(`| ${markdown(name)} | ${value.count} | ${value.median ?? "N/A"} | ${value.p75 ?? "N/A"} | ${value.p90 ?? "N/A"} | ${value.p95 ?? "N/A"} | ${value.p99 ?? "N/A"} | ${value.maximum ?? "N/A"} |`);
  lines.push("", "## 6. Latency and dispatch matrix", "", ...scenarioTable(s.latencyDispatchMatrix));
  lines.push("", "## 7. Depth and tick stress", "", ...scenarioTable(s.depthTickStress));
  lines.push("", "## 8. Residual and recovery outcomes", "",
    `- One-leg residuals: ${s.residualRecoveryOutcomes.residuals}`,
    `- Unknown outcomes: ${s.residualRecoveryOutcomes.unknownOutcomes}`,
    `- Recovery attempts/dispositions: ${s.residualRecoveryOutcomes.recoveryAttempts}/${s.residualRecoveryOutcomes.recoveryDispositions}`,
    `- Paired settlements: ${s.residualRecoveryOutcomes.pairedSettlements}`);
  lines.push("", "## 9. P&L and drawdown", "",
    `- Realized P&L6: ${s.pnlDrawdown.baselineRealizedPnl6}`,
    `- Unresolved worst-case P&L6: ${s.pnlDrawdown.baselineUnresolvedWorstCasePnl6}`,
    `- Conservative total P&L6: ${s.pnlDrawdown.baselineConservativeTotalPnl6}`,
    `- Maximum drawdown6: ${s.pnlDrawdown.baselineMaximumDrawdown6}`,
    `- Peak capital at risk6: ${s.pnlDrawdown.baselinePeakCapitalAtRisk6}`);
  lines.push("", "## 10. Data-quality exclusions", "", "| Code | Count | Detail |", "|---|---:|---|");
  if (s.dataQualityExclusions.length === 0) lines.push("| NONE | 0 | None declared |");
  else for (const item of s.dataQualityExclusions) lines.push(`| ${markdown(item.code)} | ${item.count} | ${markdown(item.detail)} |`);
  lines.push("", "## 11. Sensitivity and limitations", "",
    `- Primary UTC-day interval: ${s.sensitivityLimitations.primaryIntervalStatus}`,
    `- Market sensitivity interval: ${s.sensitivityLimitations.marketIntervalStatus}`);
  if (s.sensitivityLimitations.limitations.length === 0) lines.push("- None declared.");
  else for (const limitation of s.sensitivityLimitations.limitations) lines.push(`- ${markdown(limitation)}`);
  lines.push("", "## 12. Promotion-gate verdict", "", `Verdict: **${report.verdict}**. Live capability: **false**.`, "", "| Gate | Passed | Evidence |", "|---|---:|---|");
  for (const gate of s.promotionGateVerdict.gates) lines.push(`| ${gate.gate} | ${gate.passed ? "YES" : "NO"} | ${markdown(gate.evidence)} |`);
  lines.push("", "## 13. Reproduction hashes and commands", "",
    `- Scenario matrix hash: \`${s.reproduction.scenarioMatrixHash}\``,
    `- Scenario run hash: \`${s.reproduction.scenarioRunOutputHash}\``,
    `- Statistics hashes: ${s.reproduction.statisticsHashes.map((v) => `\`${v}\``).join(", ")}`,
    `- Config hashes: \`${s.reproduction.baseConfigHash}\` / \`${s.reproduction.observerOperationalHash}\``,
    `- Provenance hash: \`${s.reproduction.provenanceHash}\``,
    `- Algorithms: ${s.reproduction.algorithmVersions.map((v) => `\`${markdown(v)}\``).join(", ")}`,
    `- Algorithm-set hash: \`${s.reproduction.algorithmSetHash}\``,
    "",
    "Reproduce:",
    "",
    `    ${s.reproduction.command}`,
    "",
  );
  return lines.join("\n");
}

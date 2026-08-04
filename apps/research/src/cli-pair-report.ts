import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildPairDatasetManifest, canonicalPairDatasetJson, pairDatasetObjectHash } from "./pair-dataset-manifest";
import { loadPairReplayDataset, replayPairMarketDataset } from "./pair-market-replay";
import { computePairEpisodeStatistics, PAIR_FUNNEL_METRICS } from "./pair-episode-statistics";
import { generatePairResearchReportArtifacts, type PairReportArtifactResult } from "./pair-report-artifacts";
import { planPairResearchScenarioMatrix } from "./pair-research-scenario";
import { runPairResearchScenarioMatrix } from "./pair-scenario-runner";
import type { PairResearchReportInput } from "./pair-research-report";

interface PairReportBundle {
  readonly repositoryRoot: string;
  readonly reportInput: PairResearchReportInput;
}

export async function generateSyntheticZeroOpportunityReport(repositoryRoot: string): Promise<PairReportArtifactResult> {
  const root = path.resolve(repositoryRoot);
  const runId = "synthetic-zero-opportunity-v1";
  const manifest = await buildPairDatasetManifest({
    root,
    datasetId: "synthetic-zero-opportunity-validation-v1",
    selection: { purpose: "VALIDATION_ONLY", empiricalEvidence: false, marketCount: 0, episodeCount: 0 },
    artifacts: [],
  });
  const loaded = await loadPairReplayDataset(root, manifest);
  const replay = replayPairMarketDataset({ manifest, ...loaded });
  const scenarioMatrix = planPairResearchScenarioMatrix({
    measuredProcessingP95Ms: 300,
    modeledVirtualMergeDelayMs: 1_000,
    modeledVirtualMergeCost6: "0",
  });
  const scenarioRun = await runPairResearchScenarioMatrix({
    runId,
    sourceAccountId: "synthetic-validation-account",
    matrix: scenarioMatrix,
    replay,
    evaluate: ({ scenario }) => ({ designCellId: scenario.designCellId, validationOnly: true, opportunityCount: 0n }),
  });
  const funnel = PAIR_FUNNEL_METRICS.map((metric) => ({ metric, count: 0n, denominator: 0n }));
  const statistics = scenarioRun.scenarioRuns.map((scenario) => computePairEpisodeStatistics({ runId, scenarioRun: scenario, funnel, episodes: [] }));
  const fixedHash = (label: string) => pairDatasetObjectHash({ syntheticValidationOnly: true, label });
  return generatePairResearchReportArtifacts({
    repositoryRoot: root,
    reportInput: {
      runId,
      datasetRoot: root,
      manifest,
      replay,
      scenarioMatrix,
      scenarioRun,
      statistics,
      provenance: {
        codeCommit: "0000000",
        strategyVersion: "synthetic_validation_only_v1",
        baseConfigHash: fixedHash("base-config"),
        observerOperationalHash: fixedHash("observer-operational"),
        paperVenueVersion: "synthetic_no_venue_v1",
      },
      promotionEvidence: {
        capturesWithinConfiguredAgeSkew: false,
        humanReviewCompleted: false,
        unexplainedIntegrityMismatchCount: "0",
        measuredExecutableNotional6: "0",
        operationalCostThreshold6: "1",
      },
      dataQualityExclusions: [{ code: "SYNTHETIC_VALIDATION_ONLY", count: "0", detail: "No empirical markets, days, episodes, or opportunities are present." }],
      limitations: ["Synthetic validation-only artifact; it is not empirical evidence and cannot promote paper scheduling."],
      reproductionCommand: "pnpm --filter @b5p/research report:pairs:zero",
    },
  });
}

export async function runPairReportCli(argv = process.argv.slice(2)): Promise<PairReportArtifactResult> {
  if (argv[0] === "--zero-validation") {
    const defaultRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../");
    return generateSyntheticZeroOpportunityReport(argv[1] ?? defaultRepositoryRoot);
  }
  if (argv.length !== 1) throw new Error("usage: pair-report <bundle.json> OR pair-report --zero-validation [repository-root]");
  const bundlePath = path.resolve(argv[0]!);
  const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as PairReportBundle;
  return generatePairResearchReportArtifacts(bundle);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPairReportCli().then((result) => process.stdout.write(`${canonicalPairDatasetJson({
    directory: result.directory,
    reportJsonHash: result.reportJsonHash,
    reportMarkdownHash: result.reportMarkdownHash,
    artifactManifestHash: result.artifactManifestHash,
  })}\n`)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

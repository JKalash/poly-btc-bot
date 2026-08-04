import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateSyntheticZeroOpportunityReport } from "../src/cli-pair-report";
import { pairDatasetContentHash } from "../src/pair-dataset-manifest";
import { PairResearchReportError, validatePairReportRunId } from "../src/pair-research-report";
import { writePairResearchReportArtifacts } from "../src/pair-report-artifacts";

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "b5p-pair-report-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("pair research report", () => {
  it("emits all thirteen sections with exact JSON/Markdown totals for a zero-opportunity corpus", async () => {
    const repositoryRoot = await root();
    const result = await generateSyntheticZeroOpportunityReport(repositoryRoot);
    const jsonBytes = await readFile(result.reportJsonPath);
    const markdown = await readFile(result.reportMarkdownPath, "utf8");
    const json = JSON.parse(jsonBytes.toString("utf8")) as typeof result.report;

    expect(json.verdict).toBe("REMAIN_OBSERVER_ONLY");
    expect(json.liveCapability).toBe(false);
    expect(Object.keys(json.sections)).toHaveLength(13);
    expect(Object.keys(json.sections).sort()).toEqual([
      "dataQualityExclusions", "datasetProvenance", "depthTickStress", "episodeDistributions",
      "executiveConclusion", "feeConstraintRegime", "funnel", "latencyDispatchMatrix",
      "pnlDrawdown", "promotionGateVerdict", "reproduction", "residualRecoveryOutcomes",
      "sensitivityLimitations",
    ]);
    const episodes = json.sections.funnel.rows.find(({ metric }) => metric === "UNIQUE_OPPORTUNITY_EPISODES")!;
    expect(episodes).toMatchObject({ count: "0", denominator: "0", rate: null });
    expect(json.sections.pnlDrawdown.baselineConservativeTotalPnl6).toBe("0");
    expect(markdown).toContain("| UNIQUE_OPPORTUNITY_EPISODES | 0 | 0 | N/A |");
    expect(markdown).toContain("- Conservative total P&L6: 0");
    expect(markdown).toContain("Synthetic validation-only artifact; it is not empirical evidence");
    for (let section = 1; section <= 13; section += 1) expect(markdown).toContain(`## ${section}.`);
    expect(result.reportJsonHash).toBe(pairDatasetContentHash(jsonBytes));
    expect(result.reportMarkdownHash).toBe(pairDatasetContentHash(markdown));
    const artifactManifest = JSON.parse(await readFile(result.artifactManifestPath, "utf8")) as { files: { path: string; sha256: string }[] };
    expect(artifactManifest.files).toEqual([
      { path: "report.json", bytes: jsonBytes.byteLength, sha256: result.reportJsonHash },
      { path: "report.md", bytes: Buffer.byteLength(markdown), sha256: result.reportMarkdownHash },
    ]);
  });

  it("is byte-identical and hash-identical on an idempotent rerun", async () => {
    const repositoryRoot = await root();
    const first = await generateSyntheticZeroOpportunityReport(repositoryRoot);
    const firstJson = await readFile(first.reportJsonPath);
    const firstMarkdown = await readFile(first.reportMarkdownPath);
    const second = await generateSyntheticZeroOpportunityReport(repositoryRoot);

    expect(await readFile(second.reportJsonPath)).toEqual(firstJson);
    expect(await readFile(second.reportMarkdownPath)).toEqual(firstMarkdown);
    expect(second.reportJsonHash).toBe(first.reportJsonHash);
    expect(second.reportMarkdownHash).toBe(first.reportMarkdownHash);
    expect(second.artifactManifestHash).toBe(first.artifactManifestHash);
  });

  it("rejects artifact collisions without overwriting the conflicting file", async () => {
    const repositoryRoot = await root();
    const first = await generateSyntheticZeroOpportunityReport(repositoryRoot);
    await writeFile(first.reportMarkdownPath, "conflicting content\n");

    await expect(generateSyntheticZeroOpportunityReport(repositoryRoot)).rejects.toThrow(/artifact collision/);
    expect(await readFile(first.reportMarkdownPath, "utf8")).toBe("conflicting content\n");
  });

  it.each(["../escape", "..", ".", "/absolute", "nested/run", ""])("rejects unsafe run identifier %s", (runId) => {
    expect(() => validatePairReportRunId(runId)).toThrow(PairResearchReportError);
  });

  it("revalidates a report model's path identity at the artifact boundary", async () => {
    const repositoryRoot = await root();
    const valid = await generateSyntheticZeroOpportunityReport(repositoryRoot);
    await expect(writePairResearchReportArtifacts({
      repositoryRoot,
      report: { ...valid.report, runId: "../escape" },
    })).rejects.toThrow(/safe single path identifier/);
  });

  it("rejects a symlinked artifact directory before writing through it", async () => {
    const repositoryRoot = await root();
    const outside = await root();
    await symlink(outside, join(repositoryRoot, "artifacts"));

    await expect(generateSyntheticZeroOpportunityReport(repositoryRoot)).rejects.toThrow(/unsafe or escapes/);
    await expect(readFile(join(outside, "research", "pairs", "synthetic-zero-opportunity-v1", "report.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

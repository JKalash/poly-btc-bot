import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { canonicalPairDatasetJson, pairDatasetContentHash } from "./pair-dataset-manifest";
import {
  PairResearchReportError,
  buildPairResearchReport,
  renderPairResearchReportMarkdown,
  type PairResearchReportInput,
  type PairResearchReportModel,
} from "./pair-research-report";

export interface PairReportArtifactFile {
  readonly path: "report.json" | "report.md";
  readonly bytes: number;
  readonly sha256: string;
}

export interface PairReportArtifactManifest {
  readonly artifactManifestVersion: "pair_report_artifacts_v1";
  readonly runId: string;
  readonly files: readonly PairReportArtifactFile[];
}

export interface PairReportArtifactResult {
  readonly directory: string;
  readonly reportJsonPath: string;
  readonly reportMarkdownPath: string;
  readonly artifactManifestPath: string;
  readonly reportJsonHash: string;
  readonly reportMarkdownHash: string;
  readonly artifactManifestHash: string;
  readonly report: PairResearchReportModel;
}

const encoder = new TextEncoder();

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

async function existingBytes(file: string): Promise<Uint8Array | null> {
  try { return await readFile(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new PairResearchReportError(`report artifact is not a readable regular file: ${file}`, { cause: error });
  }
}

async function atomicCreate(file: string, bytes: Uint8Array): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    try { await link(temporary, file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(file);
      if (!sameBytes(existing, bytes)) throw new PairResearchReportError(`report artifact collision: ${file}`);
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function writePairResearchReportArtifacts(input: {
  readonly repositoryRoot: string;
  readonly report: PairResearchReportModel;
}): Promise<PairReportArtifactResult> {
  const repositoryRoot = await realpath(input.repositoryRoot);
  const directory = path.join(repositoryRoot, "artifacts", "research", "pairs", input.report.runId);
  await mkdir(directory, { recursive: true });
  const directoryStat = await lstat(directory);
  const directoryReal = await realpath(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()
    || (directoryReal !== repositoryRoot && !directoryReal.startsWith(`${repositoryRoot}${path.sep}`))) {
    throw new PairResearchReportError("report output directory is unsafe or escapes repository root");
  }
  const reportJson = encoder.encode(canonicalPairDatasetJson(input.report));
  const reportMarkdown = encoder.encode(renderPairResearchReportMarkdown(input.report));
  const files: readonly PairReportArtifactFile[] = Object.freeze([
    Object.freeze({ path: "report.json" as const, bytes: reportJson.byteLength, sha256: pairDatasetContentHash(reportJson) }),
    Object.freeze({ path: "report.md" as const, bytes: reportMarkdown.byteLength, sha256: pairDatasetContentHash(reportMarkdown) }),
  ]);
  const artifactManifest: PairReportArtifactManifest = Object.freeze({
    artifactManifestVersion: "pair_report_artifacts_v1",
    runId: input.report.runId,
    files,
  });
  const artifactManifestBytes = encoder.encode(canonicalPairDatasetJson(artifactManifest));
  const planned = [
    { file: path.join(directory, "report.json"), bytes: reportJson },
    { file: path.join(directory, "report.md"), bytes: reportMarkdown },
    { file: path.join(directory, "artifact-manifest.json"), bytes: artifactManifestBytes },
  ] as const;
  for (const item of planned) {
    const existing = await existingBytes(item.file);
    if (existing !== null && !sameBytes(existing, item.bytes)) throw new PairResearchReportError(`report artifact collision: ${item.file}`);
  }
  const lockPath = path.join(directory, ".publish.lock");
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) { throw new PairResearchReportError("report artifact publication is already in progress", { cause: error }); }
  try {
    for (const item of planned) if (await existingBytes(item.file) === null) await atomicCreate(item.file, item.bytes);
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  }
  return Object.freeze({
    directory,
    reportJsonPath: planned[0].file,
    reportMarkdownPath: planned[1].file,
    artifactManifestPath: planned[2].file,
    reportJsonHash: files[0]!.sha256,
    reportMarkdownHash: files[1]!.sha256,
    artifactManifestHash: pairDatasetContentHash(artifactManifestBytes),
    report: input.report,
  });
}

export async function generatePairResearchReportArtifacts(input: {
  readonly repositoryRoot: string;
  readonly reportInput: PairResearchReportInput;
}): Promise<PairReportArtifactResult> {
  const report = await buildPairResearchReport(input.reportInput);
  return writePairResearchReportArtifacts({ repositoryRoot: input.repositoryRoot, report });
}

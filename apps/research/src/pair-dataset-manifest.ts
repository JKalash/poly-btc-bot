import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

export type PairDatasetArtifactRole =
  | "MARKET_EVENTS"
  | "BOOK_CHECKPOINTS"
  | "FEE_SNAPSHOTS"
  | "CONSTRAINT_SNAPSHOTS"
  | "RESOLUTIONS";

const PAIR_DATASET_ARTIFACT_ROLES = new Set<PairDatasetArtifactRole>([
  "MARKET_EVENTS",
  "BOOK_CHECKPOINTS",
  "FEE_SNAPSHOTS",
  "CONSTRAINT_SNAPSHOTS",
  "RESOLUTIONS",
]);

export interface PairDatasetArtifactEntry {
  readonly path: string;
  readonly role: PairDatasetArtifactRole;
  readonly bytes: number;
  readonly sha256: string;
}

export interface PairDatasetManifest {
  readonly datasetManifestVersion: 1;
  readonly datasetId: string;
  readonly selection: Readonly<Record<string, unknown>>;
  readonly clockModelVersion: "pair_replay_clock_v1";
  readonly tieRuleVersion: "pair_replay_tie_v1";
  readonly artifacts: readonly PairDatasetArtifactEntry[];
  readonly datasetHash: string;
}

export class PairDatasetManifestError extends Error {}
export class PairDatasetPathError extends PairDatasetManifestError {}
export class PairDatasetHashMismatchError extends PairDatasetManifestError {}

type Canonical = null | boolean | number | string | readonly Canonical[] | { readonly [key: string]: Canonical };

function canonicalValue(value: unknown, at = "$", seen = new Set<object>()): Canonical {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new PairDatasetManifestError(`${at} number must be a safe integer`);
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new PairDatasetManifestError(`${at} contains a cycle`);
    seen.add(value);
    const result = value.map((item, index) => canonicalValue(item, `${at}[${index}]`, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new PairDatasetManifestError(`${at} contains a cycle`);
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new PairDatasetManifestError(`${at} must be a plain object`);
    seen.add(value);
    const out: Record<string, Canonical> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) throw new PairDatasetManifestError(`${at}.${key} must not be undefined`);
      out[key] = canonicalValue(item, `${at}.${key}`, seen);
    }
    seen.delete(value);
    return out;
  }
  throw new PairDatasetManifestError(`${at} contains unsupported ${typeof value}`);
}

export function canonicalPairDatasetJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function pairDatasetContentHash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function pairDatasetObjectHash(value: unknown): string {
  return pairDatasetContentHash(canonicalPairDatasetJson(value));
}

export function validatePairArtifactPath(relativePath: string): string {
  if (relativePath.length === 0 || relativePath.includes("\\") || path.isAbsolute(relativePath)) {
    throw new PairDatasetPathError("artifact path must be a non-empty canonical relative POSIX path");
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new PairDatasetPathError("artifact path contains an empty, dot, or traversal segment");
  }
  const normalized = path.posix.normalize(relativePath);
  if (normalized !== relativePath || normalized.startsWith("../")) {
    throw new PairDatasetPathError("artifact path is not canonical or escapes its root");
  }
  return normalized;
}

async function safeArtifact(root: string, relativePath: string): Promise<{ absolutePath: string; bytes: Uint8Array }> {
  const safe = validatePairArtifactPath(relativePath);
  const rootReal = await realpath(root);
  const candidate = path.resolve(rootReal, ...safe.split("/"));
  let candidateReal: string;
  try {
    candidateReal = await realpath(candidate);
  } catch (error) {
    throw new PairDatasetPathError(`artifact is unavailable: ${safe}`, { cause: error });
  }
  if (candidateReal !== rootReal && !candidateReal.startsWith(`${rootReal}${path.sep}`)) {
    throw new PairDatasetPathError(`artifact symlink escapes dataset root: ${safe}`);
  }
  const stat = await lstat(candidateReal);
  if (!stat.isFile()) throw new PairDatasetPathError(`artifact is not a regular file: ${safe}`);
  return { absolutePath: candidateReal, bytes: await readFile(candidateReal) };
}

function manifestMaterial(input: Omit<PairDatasetManifest, "datasetHash">): unknown {
  return input;
}

export async function buildPairDatasetManifest(input: {
  readonly root: string;
  readonly datasetId: string;
  readonly selection: Readonly<Record<string, unknown>>;
  readonly artifacts: readonly { readonly path: string; readonly role: PairDatasetArtifactRole }[];
}): Promise<PairDatasetManifest> {
  if (input.datasetId.trim().length === 0) throw new PairDatasetManifestError("datasetId must be non-empty");
  const duplicatePaths = new Set<string>();
  const artifacts: PairDatasetArtifactEntry[] = [];
  for (const candidate of input.artifacts) {
    const safePath = validatePairArtifactPath(candidate.path);
    if (duplicatePaths.has(safePath)) throw new PairDatasetManifestError(`duplicate artifact path: ${safePath}`);
    duplicatePaths.add(safePath);
    const loaded = await safeArtifact(input.root, safePath);
    artifacts.push(Object.freeze({
      path: safePath,
      role: candidate.role,
      bytes: loaded.bytes.byteLength,
      sha256: pairDatasetContentHash(loaded.bytes),
    }));
  }
  artifacts.sort((a, b) => a.path.localeCompare(b.path) || a.role.localeCompare(b.role));
  const material = Object.freeze({
    datasetManifestVersion: 1 as const,
    datasetId: input.datasetId,
    selection: canonicalValue(input.selection) as Readonly<Record<string, unknown>>,
    clockModelVersion: "pair_replay_clock_v1" as const,
    tieRuleVersion: "pair_replay_tie_v1" as const,
    artifacts: Object.freeze(artifacts),
  });
  return Object.freeze({ ...material, datasetHash: pairDatasetObjectHash(manifestMaterial(material)) });
}

export async function verifyPairDatasetManifest(
  root: string,
  manifest: PairDatasetManifest,
): Promise<ReadonlyMap<string, Uint8Array>> {
  if (manifest.datasetManifestVersion !== 1 || manifest.clockModelVersion !== "pair_replay_clock_v1" || manifest.tieRuleVersion !== "pair_replay_tie_v1") {
    throw new PairDatasetManifestError("unsupported dataset manifest or clock/tie version");
  }
  if (typeof manifest.datasetId !== "string" || manifest.datasetId.trim().length === 0) {
    throw new PairDatasetManifestError("datasetId must be non-empty");
  }
  const expectedOrder = [...manifest.artifacts].sort((a, b) => a.path.localeCompare(b.path) || a.role.localeCompare(b.role));
  if (expectedOrder.some((entry, index) => entry !== manifest.artifacts[index])) {
    throw new PairDatasetManifestError("manifest artifacts must be canonically ordered");
  }
  const { datasetHash: _hash, ...material } = manifest;
  const calculatedDatasetHash = pairDatasetObjectHash(manifestMaterial(material));
  if (calculatedDatasetHash !== manifest.datasetHash) {
    throw new PairDatasetHashMismatchError("dataset manifest hash mismatch");
  }
  const contents = new Map<string, Uint8Array>();
  const seenPaths = new Set<string>();
  for (const entry of manifest.artifacts) {
    if (!PAIR_DATASET_ARTIFACT_ROLES.has(entry.role)) throw new PairDatasetManifestError(`invalid artifact role: ${entry.path}`);
    if (seenPaths.has(entry.path)) throw new PairDatasetManifestError(`duplicate artifact path: ${entry.path}`);
    seenPaths.add(entry.path);
    if (!/^[0-9a-f]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      throw new PairDatasetManifestError(`invalid artifact metadata: ${entry.path}`);
    }
    const loaded = await safeArtifact(root, entry.path);
    const actualHash = pairDatasetContentHash(loaded.bytes);
    if (loaded.bytes.byteLength !== entry.bytes || actualHash !== entry.sha256) {
      throw new PairDatasetHashMismatchError(`artifact content hash mismatch: ${entry.path}`);
    }
    contents.set(entry.path, loaded.bytes);
  }
  return contents;
}

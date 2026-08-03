import { sha256OfCanonicalJson, sha256OfFile } from "@b5p/evidence";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type {
  ClaimComparison, DatasetChecksumEntry, PreregisteredDefinition, PyResultDoc,
  ReproContext, ReproVerdict,
} from "./types";

/** Walk up from cwd to the pnpm workspace root. */
export function workspaceRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function gitSha(root: string): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export function pythonBin(root: string): string {
  return path.join(root, "apps", "research", "py", ".venv", "bin", "python");
}

export function reproScriptPath(root: string, script: string): string {
  return path.join(root, "apps", "research", "py", "repro", script);
}

/**
 * Content-addressed definition id: hash of the PREREGISTERED fields. Changing
 * the primary metric (or any preregistered field) is a new definition id —
 * preregistration integrity is enforced by construction, and tested.
 */
export function definitionId(def: PreregisteredDefinition): string {
  const hash = sha256OfCanonicalJson({
    experimentKey: def.experimentKey,
    hypothesis: def.hypothesis,
    nullHypothesis: def.nullHypothesis,
    primaryMetric: def.primaryMetric,
    successCriteria: def.successCriteria,
    foldPlan: def.foldPlan,
    datasetKeys: def.datasetKeys,
  });
  return `exp-${def.experimentKey.toLowerCase().replaceAll("_", "-")}-${hash.slice(0, 8)}`;
}

/** Deterministic run id: same definition + datasets + params + seed => same run row. */
export function runId(defId: string, datasetChecksums: DatasetChecksumEntry[],
                      params: Record<string, unknown>, seed: number): string {
  const hash = sha256OfCanonicalJson({ defId, datasetChecksums, params, seed });
  return `run-${defId.slice(4)}-${hash.slice(0, 8)}`;
}

/** Checksum the input files a run consumed (absent files recorded as null, never invented). */
export async function checksumInputs(root: string, absPaths: string[]): Promise<DatasetChecksumEntry[]> {
  const out: DatasetChecksumEntry[] = [];
  for (const p of absPaths) {
    const rel = path.relative(root, p);
    if (existsSync(p)) {
      const { sha256, bytes } = await sha256OfFile(p);
      out.push({ path: rel, sha256, bytes });
    } else {
      out.push({ path: rel, sha256: null, bytes: null });
    }
  }
  return out;
}

export interface RunPyOptions {
  ctx: ReproContext;
  script: string;
  outName: string;
  needsKachoio?: boolean;
  extraParams?: Record<string, unknown>;
  timeoutMs?: number;
}

/**
 * Run one repro python script and parse its JSON document. Deterministic by
 * contract (seeded, no network, sorted output). Stdout is the document file;
 * stderr passes through for visibility.
 */
export function runPy(opts: RunPyOptions): PyResultDoc {
  const { ctx } = opts;
  mkdirSync(ctx.outDir, { recursive: true });
  const outPath = path.join(ctx.outDir, opts.outName);
  const args = [reproScriptPath(ctx.root, opts.script), "--out", outPath, "--seed", String(ctx.seed)];
  if (opts.needsKachoio !== false) {
    args.push("--markets", ctx.marketsPath, "--ticks", ctx.ticksPath);
  }
  args.push("--collector-dir", ctx.collectorDir);
  if (ctx.quick) args.push("--quick");
  if (opts.extraParams && Object.keys(opts.extraParams).length > 0) {
    const paramsPath = path.join(ctx.outDir, opts.outName.replace(/\.json$/, ".params.json"));
    writeFileSync(paramsPath, JSON.stringify(opts.extraParams, null, 1));
    args.push("--params", paramsPath);
  }
  execFileSync(ctx.pythonBin, args, {
    cwd: path.join(ctx.root, "apps", "research", "py"),
    stdio: ["ignore", "inherit", "inherit"],
    timeout: opts.timeoutMs ?? 600_000,
    env: { ...process.env, PYTHONHASHSEED: "0" },
  });
  return JSON.parse(readFileSync(outPath, "utf8")) as PyResultDoc;
}

/** sha256 over canonical JSON of the observations array — the determinism seal. */
export function observationsChecksum(observations: unknown): string {
  return sha256OfCanonicalJson(observations);
}

export function makeContext(overrides: Partial<ReproContext> = {}): ReproContext {
  const root = overrides.root ?? workspaceRoot();
  return {
    root,
    pythonBin: overrides.pythonBin ?? pythonBin(root),
    outDir: overrides.outDir ?? path.join(root, "apps", "research", "py", "out", "repro"),
    marketsPath: overrides.marketsPath ?? path.join(root, "data", "research", "kachoio", "btc_markets.parquet"),
    ticksPath: overrides.ticksPath ?? path.join(root, "data", "research", "kachoio", "btc_ticks.parquet"),
    collectorDir: overrides.collectorDir ?? path.join(root, "apps", "research", "py", "out", "collector_export"),
    datasetKey: overrides.datasetKey ?? "kachoio_btc5m_2026q2",
    seed: overrides.seed ?? 42,
    quick: overrides.quick ?? false,
    nowMs: overrides.nowMs ?? Date.now(),
    codeVersion: overrides.codeVersion ?? gitSha(root),
  };
}

/** Shorthand for building a claim comparison with a deterministic evidence id. */
export function comparison(args: {
  sourceKey: string; claimKey: string; title: string; claimText: string;
  claimedValue: string | null; units: string | null; matchRule: string;
  reproducedValue: string | null; verdict: ReproVerdict;
  gatedBy?: string | null; notes?: string | null;
}): ClaimComparison {
  return {
    evidenceId: `se-repro-${args.sourceKey}-${args.claimKey}`.toLowerCase().replaceAll("_", "-"),
    sourceKey: args.sourceKey,
    claimKey: args.claimKey,
    title: args.title,
    claimText: args.claimText,
    claimedValue: args.claimedValue,
    units: args.units,
    matchRule: args.matchRule,
    reproducedValue: args.reproducedValue,
    verdict: args.verdict,
    gatedBy: args.gatedBy ?? null,
    notes: args.notes ?? null,
  };
}

export function fmt(x: number | null | undefined, digits = 4): string {
  return x == null || Number.isNaN(x) ? "n/a" : x.toFixed(digits);
}

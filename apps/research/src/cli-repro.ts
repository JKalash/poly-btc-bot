import { makeDb } from "@b5p/db";
import { sha256OfFile, type DatasetFileEntry } from "@b5p/evidence";
import { existsSync } from "node:fs";
import path from "node:path";

import { makeContext } from "./repro/common";
import { exportCollector, COLLECTOR_DATASET_KEY, COLLECTOR_MANIFEST_ID } from "./repro/export-collector";
import { REPRO_EXPERIMENTS, findExperiment } from "./repro/index";
import { persistReproRun, upsertManifest } from "./repro/persist";
import type { ReproExperiment } from "./repro/types";

/**
 * CLI: run the R1-R8/R11 source reproductions and seed definitions, runs,
 * observations, and labeled source_evidence rows.
 *
 *   pnpm --filter @b5p/research repro                 # all experiments
 *   pnpm --filter @b5p/research repro -- --only r3,r8 # subset
 *   pnpm --filter @b5p/research repro -- --quick      # deterministic subsample
 *   pnpm --filter @b5p/research repro -- --no-persist # run + print only
 *   pnpm --filter @b5p/research repro -- --refresh-collector
 */

function parseArgs(argv: string[]) {
  const args = { only: null as string[] | null, quick: false, persist: true, refreshCollector: false, seed: 42 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--only") args.only = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a.startsWith("--only=")) args.only = a.slice(7).split(",").filter(Boolean);
    else if (a === "--quick") args.quick = true;
    else if (a === "--no-persist") args.persist = false;
    else if (a === "--refresh-collector") args.refreshCollector = true;
    else if (a === "--seed") args.seed = Number(argv[++i]);
    else if (a.startsWith("--seed=")) args.seed = Number(a.slice(7));
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const ctx = makeContext({ quick: args.quick, seed: args.seed });

let experiments: ReproExperiment[];
if (args.only) {
  experiments = [];
  for (const name of args.only) {
    const e = findExperiment(name);
    if (!e) {
      console.error(`unknown experiment "${name}" (known: ${REPRO_EXPERIMENTS.map((x) => x.key).join(", ")})`);
      process.exit(2);
    }
    experiments.push(e);
  }
} else {
  experiments = [...REPRO_EXPERIMENTS];
}

// ---- collector export (best effort; absence gates, never blocks) ----------
const needCollector = experiments.some((e) => e.definition.datasetKeys.includes(COLLECTOR_DATASET_KEY));
let collectorFiles: DatasetFileEntry[] | null = null;
if (needCollector) {
  const marker = path.join(ctx.collectorDir, "ref_ticks.csv");
  if (args.refreshCollector || !existsSync(marker)) {
    const r = await exportCollector(ctx.root, ctx.collectorDir);
    if (r.ok) {
      collectorFiles = r.files;
      console.log(`[repro] collector export: ${r.refTickRows} ref ticks, ${r.featureRows} feature rows, ${r.marketRows} markets`);
    } else {
      console.log(`[repro] collector export unavailable (${r.reason}) — collector-dependent parts will be DATA_GATED`);
    }
  } else {
    collectorFiles = [];
    for (const name of ["ref_ticks.csv", "markets.csv", "feature_market_snapshots.csv"]) {
      const p = path.join(ctx.collectorDir, name);
      if (existsSync(p)) {
        const { sha256, bytes } = await sha256OfFile(p);
        collectorFiles.push({ path: path.relative(ctx.root, p), sha256, bytes, rows: null });
      }
    }
    console.log(`[repro] collector export reused (${collectorFiles.length} files; --refresh-collector to rebuild)`);
  }
}

// ---- dataset manifests ----------------------------------------------------
const manifestIdsByDatasetKey: Record<string, string> = {};
let handle: Awaited<ReturnType<typeof makeDb>> | null = null;
if (args.persist) {
  handle = await makeDb();
  await handle.migrate();

  const kachoioFiles: DatasetFileEntry[] = [];
  for (const p of [ctx.marketsPath, ctx.ticksPath]) {
    if (existsSync(p)) {
      const { sha256, bytes } = await sha256OfFile(p);
      kachoioFiles.push({ path: path.relative(ctx.root, p), sha256, bytes, rows: null });
    } else {
      kachoioFiles.push({ path: path.relative(ctx.root, p), sha256: null, bytes: null, rows: null });
    }
  }
  const kachoio = await upsertManifest(handle, {
    id: "dm-kachoio-btc5m-2026q2",
    datasetKey: ctx.datasetKey,
    title: "kachoio CC0 Polymarket BTC 5-minute corpus (Mar-May 2026)",
    source: "kachoio CC0 dataset release; re-download instructions in docs/research/calibration-study-2026-08.md",
    license: "CC0",
    files: kachoioFiles,
    schemaDescription: null,
    nowMs: ctx.nowMs,
  });
  manifestIdsByDatasetKey[ctx.datasetKey] = kachoio.id;
  if (kachoio.drifted) console.warn("[repro] WARNING: kachoio files on disk differ from the recorded manifest (drift recorded)");

  if (collectorFiles && collectorFiles.length > 0) {
    const collector = await upsertManifest(handle, {
      id: COLLECTOR_MANIFEST_ID,
      datasetKey: COLLECTOR_DATASET_KEY,
      title: "Local collector export: BTC reference ticks + engine feature snapshots (Jul 31 - Aug 3 2026)",
      source: "embedded PGlite collector DB (data/pglite); deterministic SELECT-only export via apps/research repro CLI",
      license: null,
      files: collectorFiles,
      schemaDescription: "see apps/research/src/repro/export-collector.ts",
      nowMs: ctx.nowMs,
    });
    manifestIdsByDatasetKey[COLLECTOR_DATASET_KEY] = collector.id;
  }
}

// ---- run ------------------------------------------------------------------
let failed = 0;
for (const exp of experiments) {
  process.stdout.write(`[repro] ${exp.key} ... `);
  try {
    const result = await exp.run(ctx);
    const verdictCounts = result.comparisons.reduce<Record<string, number>>((acc, c) => {
      acc[c.verdict] = (acc[c.verdict] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`${result.hypothesisStatus} (${(result.runtimeMs / 1000).toFixed(1)}s)`);
    console.log(`        ${result.headline}`);
    console.log(`        claims: ${Object.entries(verdictCounts).map(([k, v]) => `${k}=${v}`).join(" ") || "none"}`);
    for (const c of result.comparisons.filter((c) => c.verdict === "DATA_GATED")) {
      console.log(`        DATA_GATED ${c.claimKey}: ${c.gatedBy}`);
    }
    if (handle) {
      const p = await persistReproRun(handle, exp, ctx, result, manifestIdsByDatasetKey);
      console.log(`        persisted: def ${p.definitionId} run ${p.runId} (${p.observationRows} obs, ${p.evidenceRows} evidence, checksum ${p.resultChecksum.slice(0, 12)}…)`);
    }
  } catch (e) {
    failed++;
    console.log("FAILED");
    console.error(`        ${(e as Error).message}`);
  }
}

if (handle) await handle.close();
if (failed > 0) {
  console.error(`[repro] ${failed} experiment(s) failed`);
  process.exit(1);
}
console.log(`[repro] done: ${experiments.length} experiment(s)`);

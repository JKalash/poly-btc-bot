import {
  datasetManifests, experimentDefinitions, experimentRuns, sourceEvidence, type DbHandle,
} from "@b5p/db";
import { sha256OfCanonicalJson, sha256OfFile, type DatasetFileEntry, type EvidenceLabel } from "@b5p/evidence";
import { newId } from "@b5p/domain/ids";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Provenance backfill for the 2026-08 calibration study: the kachoio dataset
 * manifest (checksummed when the files are on disk) plus the study itself as
 * a first-class experiment definition + run, and the study's headline findings
 * as labeled source-evidence rows.
 *
 * Idempotent: deterministic ids, upsert-on-conflict. Claims quote
 * docs/research/calibration-study-2026-08.md; reproduced values are extracted
 * from data/research/kachoio/study_results.json when present.
 */

const MANIFEST_ID = "dm-kachoio-btc5m-2026q2";
const DEFINITION_ID = "exp-calibration-study-2026-08";
const RUN_ID = "run-calibration-study-2026-08";
const DATASET_KEY = "kachoio_btc5m_2026q2";
const STUDY_SOURCE = "b5p_calibration_study_2026_08";
const KACHOIO_FILES = ["btc_markets.parquet", "btc_ticks.parquet", "study_results.json"];

function workspaceRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function gitSha(root: string): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

interface StudyResults {
  dataset?: { markets_resolved?: number; ticks?: number; date_range?: [string, string]; up_rate_overall?: number };
  slices?: Record<string, { oos?: { n?: number; auc_model?: number; auc_mid?: number; days?: number } }>;
  executor_validation_T90_join?: Record<string, unknown>;
  two_sided_scan?: Record<string, unknown>;
}

export interface SeedEvidenceResult {
  manifestMaterialized: boolean;
  filesChecksummed: number;
  evidenceRows: number;
  runBackfilled: boolean;
}

export async function seedEvidence(handle: DbHandle, nowMs: number): Promise<SeedEvidenceResult> {
  const root = workspaceRoot();
  const dataDir = path.join(root, "data", "research", "kachoio");
  const codeVersion = gitSha(root);

  // ---- dataset manifest (checksum what exists; record absence honestly) ----
  const files: DatasetFileEntry[] = [];
  let checksummed = 0;
  for (const name of KACHOIO_FILES) {
    const p = path.join(dataDir, name);
    if (existsSync(p)) {
      const { sha256, bytes } = await sha256OfFile(p);
      files.push({ path: `data/research/kachoio/${name}`, sha256, bytes, rows: null });
      checksummed++;
    } else {
      files.push({ path: `data/research/kachoio/${name}`, sha256: null, bytes: null, rows: null });
    }
  }
  const materialized = checksummed === KACHOIO_FILES.length;

  const studyPath = path.join(dataDir, "study_results.json");
  const study: StudyResults | null = existsSync(studyPath)
    ? (JSON.parse(readFileSync(studyPath, "utf8")) as StudyResults)
    : null;
  const range = study?.dataset?.date_range;
  const retrievedAtMs = existsSync(path.join(dataDir, "btc_ticks.parquet"))
    ? Math.round(statSync(path.join(dataDir, "btc_ticks.parquet")).mtimeMs)
    : null;

  const manifestRow = {
    id: MANIFEST_ID,
    datasetKey: DATASET_KEY,
    title: "kachoio CC0 Polymarket BTC 5-minute corpus (Mar–May 2026)",
    source: "kachoio CC0 dataset release; re-download instructions in docs/research/calibration-study-2026-08.md",
    license: "CC0",
    files,
    contentChecksum: sha256OfCanonicalJson(files),
    timeRangeStartMs: range ? Date.parse(range[0]) : null,
    timeRangeEndMs: range ? Date.parse(range[1]) : null,
    rowCount: study?.dataset?.ticks ?? null,
    schemaDescription:
      "btc_markets.parquet: one row per market (condition_id, outcome, market_start/end, ...). " +
      "btc_ticks.parquet: 1Hz two-sided top-of-book (t, condition_id, bu/au = UP bid/ask, bd/ad = DOWN bid/ask).",
    materialized,
    retrievedAtMs,
    createdAtMs: nowMs,
  };
  const { id: _mid, ...manifestSet } = manifestRow;
  await handle.db.insert(datasetManifests).values(manifestRow)
    .onConflictDoUpdate({ target: datasetManifests.id, set: manifestSet });

  // ---- the calibration study as a preregistered experiment + completed run ----
  const defRow = {
    id: DEFINITION_ID,
    experimentKey: "calibration_study_2026_08",
    title: "Can anything beat the market's own price? (walk-forward calibration study)",
    hypothesis:
      "Leakage-safe book/momentum features at fixed decision horizons (T-120/90/60/30/10s) can beat the market mid-price out of sample.",
    nullHypothesis: "I can't beat the market's own price: OOS AUC(model) <= AUC(mid) at every horizon.",
    primaryMetric: "oos_auc_delta_model_minus_mid",
    successCriteria: "Positive OOS AUC delta vs mid at any horizon, walk-forward by UTC day with >=7 train days.",
    sourceEvidenceIds: ["se-kachoio-dataset"],
    datasetKeys: [DATASET_KEY],
    foldPlan: { nFolds: 49, embargoMs: 0, purge: true, minTrainSamples: 7 },
    status: "REFUTED", // the null held at every horizon
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  const { id: _did, createdAtMs: _dcreated, ...defSet } = defRow;
  await handle.db.insert(experimentDefinitions).values(defRow)
    .onConflictDoUpdate({ target: experimentDefinitions.id, set: defSet });

  let runBackfilled = false;
  if (study) {
    const finishedAtMs = Math.round(statSync(studyPath).mtimeMs);
    const runRow = {
      id: RUN_ID,
      definitionId: DEFINITION_ID,
      runKey: "calibration_study_2026_08_kachoio",
      params: { fee: 0.07, slices_seconds_remaining: [120, 90, 60, 30, 10], min_train_days: 7, script: "apps/research/py/calibration_study.py" },
      datasetManifestIds: [MANIFEST_ID],
      codeVersion,
      configVersion: null,
      status: "COMPLETED",
      startedAtMs: finishedAtMs, // wall-clock start not recorded by the original run
      finishedAtMs,
      resultSummary: study as Record<string, unknown>,
      resultChecksum: sha256OfCanonicalJson(study),
      correlationId: newId(),
    };
    const { id: _rid, correlationId: _rcorr, ...runSet } = runRow;
    await handle.db.insert(experimentRuns).values(runRow)
      .onConflictDoUpdate({ target: experimentRuns.id, set: runSet });
    runBackfilled = true;
  }

  // ---- headline findings as labeled evidence ----
  const t60 = study?.slices?.["60"]?.oos;
  const exec = study?.executor_validation_T90_join;
  const scan = study?.two_sided_scan;
  const rows: Array<{
    id: string; sourceKey: string; claimKey: string; title: string; claimText: string;
    claimedValue: string | null; units: string | null; label: EvidenceLabel; url: string | null;
    reproducedValue: string | null; reproductionRunId: string | null; methodologyNotes: string | null;
  }> = [
    {
      id: "se-kachoio-dataset",
      sourceKey: "kachoio_dataset",
      claimKey: "cc0_btc5m_tob_1hz",
      title: "kachoio CC0 BTC 5-minute top-of-book corpus",
      claimText:
        "CC0 corpus of Polymarket BTC 5-minute markets: 1Hz two-sided top-of-book, 14,226 resolved Up/Down markets, 2026-03-24 → 2026-05-18, 4,267,718 ticks.",
      claimedValue: "14226 markets; 4267718 ticks",
      units: null,
      label: "OFFICIAL_CURRENT_AT_RETRIEVAL",
      url: null,
      reproducedValue: study?.dataset
        ? `markets_resolved=${study.dataset.markets_resolved}; ticks=${study.dataset.ticks}`
        : null,
      reproductionRunId: study ? RUN_ID : null,
      methodologyNotes: materialized ? null : "dataset files not present on this machine; manifest recorded unmaterialized",
    },
    {
      id: "se-calib-null-held",
      sourceKey: STUDY_SOURCE,
      claimKey: "null_held_mid_beats_model",
      title: "The null holds: mid-price beats the walk-forward model at every horizon",
      claimText:
        "12,655 OOS decisions across 49 walk-forward test days: AUC(mid) >= AUC(model) at T-120/90/60/30/10s; e.g. T-60s AUC mid 0.9461 vs model 0.9450. No calibration artifact ships.",
      claimedValue: "T-60s: AUC mid 0.9461 vs model 0.9450 (delta -0.0011)",
      units: "AUC",
      label: "REPRODUCED_MATCH",
      url: null,
      reproducedValue: t60 ? `T-60s OOS n=${t60.n}: auc_model=${t60.auc_model?.toFixed(4)}, auc_mid=${t60.auc_mid?.toFixed(4)}` : null,
      reproductionRunId: study ? RUN_ID : null,
      methodologyNotes: "docs/research/calibration-study-2026-08.md Result 1; replicates openmarket's 15-minute finding on the 5-minute series",
    },
    {
      id: "se-calib-maker-adverse-selection",
      sourceKey: STUDY_SOURCE,
      claimKey: "maker_fill_adverse_selection",
      title: "Passive maker fills are toxic: ~-8.8pts of win probability",
      claimText:
        "Hypothetical maker joining best UP bid at T-90s (cancel T-45s): Up wins 50.4% unconditionally but only 41.6% conditional on the level trading through (48.1% on touch).",
      claimedValue: "-8.8",
      units: "pts win probability (filled vs unconditional)",
      label: "REPRODUCED_MATCH",
      url: null,
      reproducedValue: exec ? JSON.stringify(exec) : null,
      reproductionRunId: study ? RUN_ID : null,
      methodologyNotes:
        "docs/research/calibration-study-2026-08.md Result 3. This is the fill_selection_cost mechanism the execution timeline measures live (R9).",
    },
    {
      id: "se-calib-complement-arb-nonexistent",
      sourceKey: STUDY_SOURCE,
      claimKey: "complement_arb_nonexistent",
      title: "The structural complement arb does not exist",
      claimText:
        "Buy-both-sides below $1 appears in 0.00056% of 4.27M ticks (~24s total, gross); mean buy-both cost 1.0118 — the complement gap is a ~1.2 cent toll, not income. Sell-both above $1 similarly nil.",
      claimedValue: "p_buy_both_gross=5.6e-06; mean_buy_both_cost=1.0118",
      units: null,
      label: "REPRODUCED_MATCH",
      url: null,
      reproducedValue: scan ? JSON.stringify(scan) : null,
      reproductionRunId: study ? RUN_ID : null,
      methodologyNotes:
        "docs/research/calibration-study-2026-08.md Result 4. Directly constrains the paired-execution (MrFadiAi borrow) subsystem: joint executability must be proven prospectively, never assumed from optical dislocation.",
    },
    {
      id: "se-calib-late-favorite-drift",
      sourceKey: STUDY_SOURCE,
      claimKey: "late_favorite_drift_measured",
      title: "Late-window favorite drift: measured, but attributed to the HFT latency pool",
      claimText:
        "Favorites' realized win frequency exceeds displayed mid and the gap grows into expiry (~+3 → +7.5pts, fav_mid in [0.70,0.90)); ~$90 displayed size, ask-adjusted edge ~0-2pts.",
      claimedValue: "+3 to +7.5",
      units: "pts (freq - mid) into expiry",
      label: "INTERNAL_HYPOTHESIS",
      url: null,
      reproducedValue: null,
      reproductionRunId: study ? RUN_ID : null,
      methodologyNotes:
        "The MEASUREMENT reproduces; the label stays INTERNAL_HYPOTHESIS because the attribution (stale-quote HFT pool vs harvestable edge) is unproven and partly label noise. The live paper late-snipe experiment tests it.",
    },
    {
      id: "se-spec-45-minute-anomaly",
      sourceKey: "polymarket_fable_spec",
      claimKey: "minute_45_up_anomaly",
      title: "Spec's ':45 anomaly' failed out of sample",
      claimText: "Parent spec observed :45 windows resolving Up at 54.03% (Jun 30–Jul 30 window) and flagged it as a candidate timing signal.",
      claimedValue: "0.5403",
      units: "Up rate",
      label: "REPRODUCED_MISMATCH",
      url: null,
      reproducedValue: "0.5225 (CI 0.494-0.551, p_raw 0.20, p_Bonferroni 1.0) on Mar-May corpus — not significant",
      reproductionRunId: study ? RUN_ID : null,
      methodologyNotes: "True out-of-sample test (earlier window). No minute bucket significant after correction; minute-of-hour is noise.",
    },
  ];

  for (const r of rows) {
    const full = { ...r, correlationId: newId(), configVersion: null, createdAtMs: nowMs, updatedAtMs: nowMs };
    const { id: _eid, correlationId: _ecorr, createdAtMs: _ecreated, ...evidenceSet } = full;
    await handle.db.insert(sourceEvidence).values(full)
      .onConflictDoUpdate({ target: sourceEvidence.id, set: evidenceSet });
  }

  return { manifestMaterialized: materialized, filesChecksummed: checksummed, evidenceRows: rows.length, runBackfilled };
}

import {
  datasetManifests, experimentDefinitions, experimentObservations, experimentRuns,
  sourceEvidence, type DbHandle,
} from "@b5p/db";
import { sha256OfCanonicalJson, type DatasetFileEntry } from "@b5p/evidence";
import { newId } from "@b5p/domain/ids";
import { eq } from "drizzle-orm";

import { definitionId, observationsChecksum, runId } from "./common";
import type { ReproContext, ReproExperiment, ReproRunResult } from "./types";

/**
 * Persist one reproduction run into the 1a tables. Idempotent: deterministic
 * ids everywhere (definition id is content-addressed over the preregistered
 * fields; run id hashes definition + dataset checksums + params + seed;
 * observation ids derive from the run id), upsert-on-conflict, and re-running
 * the same inputs replaces the same rows byte-for-byte.
 */

export interface PersistReproResult {
  definitionId: string;
  runId: string;
  observationRows: number;
  evidenceRows: number;
  resultChecksum: string;
}

export async function persistReproRun(
  handle: DbHandle,
  exp: ReproExperiment,
  ctx: ReproContext,
  result: ReproRunResult,
  manifestIdsByDatasetKey: Record<string, string>,
): Promise<PersistReproResult> {
  const defId = definitionId(exp.definition);
  const defRow = {
    id: defId,
    experimentKey: exp.definition.experimentKey,
    title: exp.definition.title,
    hypothesis: exp.definition.hypothesis,
    nullHypothesis: exp.definition.nullHypothesis,
    primaryMetric: exp.definition.primaryMetric,
    successCriteria: exp.definition.successCriteria,
    sourceEvidenceIds: exp.definition.sourceEvidenceIds,
    datasetKeys: exp.definition.datasetKeys,
    foldPlan: exp.definition.foldPlan,
    status: result.hypothesisStatus,
    createdAtMs: ctx.nowMs,
    updatedAtMs: ctx.nowMs,
  };
  const { id: _d, createdAtMs: _dc, ...defSet } = defRow;
  await handle.db.insert(experimentDefinitions).values(defRow)
    .onConflictDoUpdate({ target: experimentDefinitions.id, set: defSet });

  const rid = runId(defId, result.datasetChecksums, result.params, ctx.seed);
  const resultChecksum = observationsChecksum(result.observations);
  const manifestIds = exp.definition.datasetKeys
    .map((k) => manifestIdsByDatasetKey[k])
    .filter((v): v is string => typeof v === "string");
  const runRow = {
    id: rid,
    definitionId: defId,
    runKey: `${exp.definition.experimentKey}_${ctx.datasetKey}_seed${ctx.seed}${ctx.quick ? "_quick" : ""}`,
    params: { ...result.params, datasetChecksums: result.datasetChecksums, seed: ctx.seed, quick: ctx.quick },
    datasetManifestIds: manifestIds,
    codeVersion: ctx.codeVersion,
    configVersion: null,
    status: result.status,
    startedAtMs: ctx.nowMs,
    finishedAtMs: ctx.nowMs + result.runtimeMs,
    resultSummary: {
      headline: result.headline,
      hypothesisStatus: result.hypothesisStatus,
      summary: result.summary,
      comparisons: result.comparisons.map((c) => ({
        claimKey: c.claimKey, verdict: c.verdict, reproducedValue: c.reproducedValue, gatedBy: c.gatedBy,
      })),
      ...(result.error ? { error: result.error } : {}),
    },
    resultChecksum,
    correlationId: newId(),
  };
  const { id: _r, correlationId: _rc, ...runSet } = runRow;
  await handle.db.insert(experimentRuns).values(runRow)
    .onConflictDoUpdate({ target: experimentRuns.id, set: runSet });

  // observations: replace-then-insert keeps re-runs exact (no stale rows)
  await handle.db.delete(experimentObservations).where(eq(experimentObservations.runId, rid));
  let obsRows = 0;
  for (const [i, o] of result.observations.entries()) {
    await handle.db.insert(experimentObservations).values({
      id: `obs-${sha256OfCanonicalJson({ rid, i, metric: o.metric, scope: o.scope }).slice(0, 16)}`,
      runId: rid,
      metric: o.metric,
      scope: o.scope,
      value: o.value,
      valueText: o.valueText,
      n: o.n,
      ciLo: o.ciLo,
      ciHi: o.ciHi,
      detail: o.detail,
      createdAtMs: ctx.nowMs,
    });
    obsRows++;
  }

  let evidenceRows = 0;
  for (const c of result.comparisons) {
    const row = {
      id: c.evidenceId,
      sourceKey: c.sourceKey,
      claimKey: c.claimKey,
      title: c.title,
      claimText: c.claimText,
      claimedValue: c.claimedValue,
      units: c.units,
      label: c.verdict,
      url: null,
      retrievedAtMs: null,
      reproducedValue: c.reproducedValue,
      reproductionRunId: rid,
      methodologyNotes: [`match rule: ${c.matchRule}`, c.gatedBy ? `gated by: ${c.gatedBy}` : null, c.notes]
        .filter(Boolean).join(" | "),
      correlationId: newId(),
      configVersion: null,
      createdAtMs: ctx.nowMs,
      updatedAtMs: ctx.nowMs,
    };
    const { id: _e, correlationId: _ec, createdAtMs: _ecr, ...evSet } = row;
    await handle.db.insert(sourceEvidence).values(row)
      .onConflictDoUpdate({ target: sourceEvidence.id, set: evSet });
    evidenceRows++;
  }

  return { definitionId: defId, runId: rid, observationRows: obsRows, evidenceRows, resultChecksum };
}

/**
 * Ensure a dataset manifest row exists for files a run consumed, WITHOUT ever
 * rewriting an existing row (the original retrieval record — e.g. the
 * seed-evidence kachoio manifest, which lists more files than a run consumes —
 * stays authoritative). When the row exists, the consumed files are VERIFIED
 * against it per path+sha256; a checksum disagreement is reported as drift for
 * the caller to surface, never silently patched.
 */
export async function upsertManifest(
  handle: DbHandle,
  row: {
    id: string; datasetKey: string; title: string; source: string; license: string | null;
    files: DatasetFileEntry[]; schemaDescription: string | null; nowMs: number;
  },
): Promise<{ id: string; drifted: boolean }> {
  const contentChecksum = sha256OfCanonicalJson(row.files);
  const existing = await handle.db.select().from(datasetManifests).where(eq(datasetManifests.id, row.id)).limit(1);
  if (existing.length > 0) {
    const prev = existing[0]!;
    const prevFiles = (prev.files ?? []) as DatasetFileEntry[];
    const bySha = new Map(prevFiles.map((f) => [f.path, f.sha256]));
    const drifted = row.files.some((f) => {
      const recorded = bySha.get(f.path);
      return recorded !== undefined && recorded !== null && f.sha256 !== null && recorded !== f.sha256;
    });
    return { id: row.id, drifted };
  }
  await handle.db.insert(datasetManifests).values({
    id: row.id,
    datasetKey: row.datasetKey,
    title: row.title,
    source: row.source,
    license: row.license,
    files: row.files,
    contentChecksum,
    timeRangeStartMs: null,
    timeRangeEndMs: null,
    rowCount: null,
    schemaDescription: row.schemaDescription,
    materialized: row.files.every((f) => f.sha256 !== null),
    retrievedAtMs: row.nowMs,
    createdAtMs: row.nowMs,
  });
  return { id: row.id, drifted: false };
}

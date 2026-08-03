import { calibrationArtifacts, modelArtifacts, strategyPromotionDecisions, type DbHandle } from "@b5p/db";
import { parseCalibrationArtifact, type StrategyPromotionDecision } from "@b5p/experiments";
import { and, eq, ne } from "drizzle-orm";
import { readFileSync } from "node:fs";

/**
 * Persist a sealed CalibrationArtifact + its StrategyPromotionDecision into the
 * registry tables (model_artifacts / calibration_artifacts /
 * strategy_promotion_decisions). The JSON files remain the sealed source of
 * truth (byte-exact seal verified before any row is written); the DB rows are
 * the queryable registry the dashboard and the governance gate read.
 *
 * Idempotent: ids come from the artifacts themselves; upsert-on-conflict.
 * A decision with active=true deactivates all other decisions for the same
 * (strategyVersion, mode) — FAILING decisions are first-class and stay active.
 */
export interface SeedCalibrationResult {
  modelArtifactId: string;
  calibrationRows: number;
  decisionId: string;
  approved: boolean;
  active: boolean;
}

export async function seedCalibration(
  handle: DbHandle,
  opts: { artifactPath: string; decisionPath: string; nowMs: number },
): Promise<SeedCalibrationResult> {
  const artifactText = readFileSync(opts.artifactPath, "utf8");
  const parsed = parseCalibrationArtifact(artifactText); // verifies the byte-exact seal first
  if (!parsed.ok || !parsed.artifact) {
    throw new Error(`artifact at ${opts.artifactPath} refused: ${parsed.reasons.join("; ")}`);
  }
  const artifact = parsed.artifact;
  const decision = JSON.parse(readFileSync(opts.decisionPath, "utf8")) as StrategyPromotionDecision;
  if (decision.calibrationArtifactId !== artifact.id) {
    throw new Error(
      `decision ${decision.id} references artifact ${decision.calibrationArtifactId}, not ${artifact.id} — wrong file pairing`,
    );
  }

  const modelRow = {
    id: artifact.id,
    modelKey: artifact.modelKey,
    version: artifact.version,
    kind: artifact.kind,
    featureNames: artifact.featureNames,
    coefficients: artifact.coefficients,
    standardization: artifact.standardization,
    datasetManifestIds: [artifact.dataset.manifestId],
    foldPlan: artifact.foldPlan,
    trainedAtMs: artifact.trainedAtMs,
    codeVersion: artifact.codeVersion,
    artifactChecksum: artifact.artifactChecksum,
    artifact: JSON.parse(artifactText) as unknown,
    createdAtMs: opts.nowMs,
  };
  await handle.db.insert(modelArtifacts).values(modelRow)
    .onConflictDoUpdate({ target: modelArtifacts.id, set: { ...modelRow, createdAtMs: undefined } });

  let calibrationRows = 0;
  for (const fit of artifact.fits) {
    const row = {
      id: `${artifact.id}:${fit.method}`,
      modelArtifactId: artifact.id,
      method: fit.method,
      curve: fit.method === "isotonic" ? (fit.curve ?? null) : null,
      platt: fit.method === "platt" ? (fit.platt ?? null) : null,
      metrics: { oofModel: artifact.oofModel, oofMidNull: artifact.oofMidNull, selected: fit.method === artifact.selectedMethod },
      perFoldMetrics: artifact.perFoldVsNull,
      codeVersion: artifact.codeVersion,
      artifactChecksum: artifact.artifactChecksum,
      createdAtMs: opts.nowMs,
    };
    await handle.db.insert(calibrationArtifacts).values(row)
      .onConflictDoUpdate({ target: calibrationArtifacts.id, set: { ...row, createdAtMs: undefined } });
    calibrationRows++;
  }

  const decisionRow = {
    id: decision.id,
    strategyVersion: decision.strategyVersion,
    modelVersion: decision.modelVersion,
    mode: decision.mode,
    approved: decision.approved,
    reasons: decision.reasons,
    evidence: decision.evidence,
    criteria: decision.criteria,
    calibrationArtifactId: `${artifact.id}:${artifact.selectedMethod}`,
    decidedBy: decision.decidedBy,
    decidedAtMs: decision.decidedAtMs,
    active: decision.active,
  };
  await handle.db.insert(strategyPromotionDecisions).values(decisionRow)
    .onConflictDoUpdate({ target: strategyPromotionDecisions.id, set: decisionRow });
  if (decision.active) {
    await handle.db.update(strategyPromotionDecisions)
      .set({ active: false })
      .where(and(
        eq(strategyPromotionDecisions.strategyVersion, decision.strategyVersion),
        eq(strategyPromotionDecisions.mode, decision.mode),
        ne(strategyPromotionDecisions.id, decision.id),
      ));
  }

  return {
    modelArtifactId: artifact.id,
    calibrationRows,
    decisionId: decision.id,
    approved: decision.approved,
    active: decision.active,
  };
}

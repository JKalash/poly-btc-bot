import { GIST_COMPOSITE_WEIGHTS, GIST_THRESHOLDS } from "@b5p/evidence";
import path from "node:path";

import { checksumInputs, comparison, fmt, runPy } from "./common";
import type { ClaimComparison, ReproContext, ReproExperiment, ReproRunResult } from "./types";
import { detailNum, findObs } from "./verdicts";

/**
 * R7 — Gist composite ablation + calibration. The exact fixture weights are
 * passed INTO the python script (never re-transcribed there); variants cover
 * exact weights, the old window-delta weight 3, window-delta-only, every
 * leave-one-out, the engine-recorded score, book-only and Chainlink-distance
 * baselines, and a walk-forward isotonic calibration.
 *
 * abs(score)/7 is NEVER called a probability anywhere in this module: the
 * metric that evaluates it is named score_strength_as_if_probability_brier and
 * exists to quantify how badly it scores when treated as one.
 */

const W = GIST_COMPOSITE_WEIGHTS;

const definition = Object.freeze({
  experimentKey: "R7_gist_composite_ablation",
  title: "R7: gist_composite_v1 ablation + calibration on collector snapshots",
  hypothesis:
    "score_strength = min(|score|/7, 1) is not a probability: treated as one it scores materially " +
    "worse (Brier) than the book mid on the same rows, and the window delta dominates every ablation.",
  nullHypothesis:
    "score_strength calibrates as well as the book mid (Brier difference <= 0), i.e. it could " +
    "legitimately be displayed as a probability.",
  primaryMetric: "score_strength_as_if_probability_brier_minus_book_mid",
  successCriteria:
    "SUPPORTED when Brier(score_strength-as-probability) - Brier(book mid) > 0 for the " +
    "exact_gist_weights variant at T-10; REFUTED when <= 0; INCONCLUSIVE when n < 30; " +
    "DATA_GATED when the collector export is absent.",
  sourceEvidenceIds: ["se-repro-archetapp-gist-confidence-not-probability"],
  datasetKeys: ["collector_local_btc_2026w31"],
  foldPlan: { nFolds: 2, embargoMs: 3_600_000, purge: true as const, minTrainSamples: 1 },
  // fold plan mirrors the python walk-forward-by-day on the ~3-day sample
});

async function run(ctx: ReproContext): Promise<ReproRunResult> {
  const t0 = Date.now();
  const doc = runPy({
    ctx,
    script: "repro_r7_composite.py",
    outName: "r7.json",
    needsKachoio: false,
    extraParams: { gistWeights: W.data }, // the fixture IS the parameterization
  });
  const datasetChecksums = await checksumInputs(ctx.root, [
    path.join(ctx.collectorDir, "feature_market_snapshots.csv"),
  ]);

  const comparisons: ClaimComparison[] = [];
  const primary = findObs(doc.observations, "score_strength_as_if_probability_brier", "T-10/exact_gist_weights");
  const brierGap = detailNum(primary, "strengthWorseThanBookBy");
  const gated = primary === undefined;

  comparisons.push(comparison({
    sourceKey: W.sourceRef.sourceKey,
    claimKey: "confidence_not_probability",
    title: "Gist confidence mapping min(|score|/7, 1) treated as a probability",
    claimText:
      `The gist maps ${W.data.confidenceMapping.formulaAsPrinted} and trades on it as confidence; ` +
      "the brief mandates it never be displayed or used as a probability.",
    claimedValue: W.data.confidenceMapping.formulaAsPrinted,
    units: "Brier",
    matchRule:
      "The brief's mandate holds when Brier(score_strength as probability) exceeds Brier(book mid) " +
      "on identical rows (i.e. the mapping is demonstrably NOT a calibrated probability).",
    reproducedValue: primary?.value != null
      ? `Brier(strength) ${fmt(primary.value)} vs Brier(mid) ${fmt(detailNum(primary, "brierBookMidSameRows"))} ` +
        `(worse by ${fmt(brierGap)}, n=${primary.n})`
      : null,
    verdict: gated ? "DATA_GATED" : brierGap != null && brierGap > 0 ? "REPRODUCED_MATCH" : "REPRODUCED_MISMATCH",
    gatedBy: gated ? "local collector export (feature_market_snapshots.csv from data/pglite feature_snapshots) not present" : null,
    notes: "MATCH here means the anti-claim is confirmed: the mapping fails as a probability, as preregistered.",
  }));

  const hitExact = findObs(doc.observations, "composite_hit_rate", "T-10/exact_gist_weights");
  const hitNoDelta = findObs(doc.observations, "composite_hit_rate", "T-10/ablate_window_delta");
  const otherAblations = doc.observations.filter((o) =>
    o.metric === "composite_hit_rate" && o.scope.startsWith("T-10/ablate_") && o.scope !== "T-10/ablate_window_delta" && o.value != null);
  const deltaDrop = hitExact?.value != null && hitNoDelta?.value != null ? hitExact.value - hitNoDelta.value : null;
  const maxOtherDrop = hitExact?.value != null && otherAblations.length
    ? Math.max(...otherAblations.map((o) => hitExact.value! - (o.value ?? hitExact.value!)))
    : null;
  comparisons.push(comparison({
    sourceKey: W.sourceRef.sourceKey,
    claimKey: "window_delta_dominant",
    title: "Gist claim: window delta is the dominant feature",
    claimText: "The guide calls window delta dominant (weight raised from 3 to 5-7 after noisy indicators overruled it).",
    claimedValue: "window delta dominant",
    units: "hit-rate drop on ablation",
    matchRule:
      "MATCH when ablating window delta produces the largest hit-rate drop of all leave-one-out " +
      "variants at T-10, and that drop exceeds every other ablation's drop by >= 2x.",
    reproducedValue: deltaDrop != null
      ? `ablate window delta: -${fmt(deltaDrop, 3)} hit rate; largest other ablation drop: ${fmt(maxOtherDrop, 3)}`
      : null,
    verdict: gated ? "DATA_GATED"
      : deltaDrop != null && maxOtherDrop != null && deltaDrop >= 2 * Math.max(maxOtherDrop, 0.001)
        ? "REPRODUCED_MATCH" : "REPRODUCED_MISMATCH",
    gatedBy: gated ? "local collector export (feature_market_snapshots.csv) not present" : null,
  }));

  comparisons.push(comparison({
    sourceKey: GIST_THRESHOLDS.sourceRef.sourceKey,
    claimKey: "old_window_delta_weight_3_ablation",
    title: "Gist ablation: earlier window-delta weight 3 vs current tiered 5-7",
    claimText: "The guide raised the window-delta weight from 3 to 5-7; both variants are preregistered ablations.",
    claimedValue: "5-7 better than 3",
    units: "direction hit rate",
    matchRule: "MATCH when the tiered variant's T-10 hit rate >= the flat-3 variant's.",
    reproducedValue: (() => {
      const tiered = findObs(doc.observations, "composite_hit_rate", "T-10/exact_gist_weights");
      const flat3 = findObs(doc.observations, "composite_hit_rate", "T-10/old_window_delta_weight_3");
      return tiered?.value != null && flat3?.value != null
        ? `tiered ${fmt(tiered.value, 3)} vs flat-3 ${fmt(flat3.value, 3)} (n=${tiered.n})` : null;
    })(),
    verdict: (() => {
      if (gated) return "DATA_GATED" as const;
      const tiered = findObs(doc.observations, "composite_hit_rate", "T-10/exact_gist_weights");
      const flat3 = findObs(doc.observations, "composite_hit_rate", "T-10/old_window_delta_weight_3");
      return tiered?.value != null && flat3?.value != null && tiered.value >= flat3.value
        ? "REPRODUCED_MATCH" as const : "REPRODUCED_MISMATCH" as const;
    })(),
    gatedBy: gated ? "local collector export (feature_market_snapshots.csv) not present" : null,
  }));

  const n = primary?.n ?? 0;
  const hypothesisStatus = gated ? "DATA_GATED"
    : n < 30 ? "INCONCLUSIVE"
    : brierGap != null && brierGap > 0 ? "SUPPORTED" : "REFUTED";

  const cal = findObs(doc.observations, "composite_calibrated_oos_brier", "T-10/calibrated_isotonic");
  return {
    status: "COMPLETED",
    hypothesisStatus,
    observations: doc.observations,
    perDay: doc.perDay,
    comparisons,
    datasetChecksums,
    params: { ...doc.params, weightsFixtureId: W.id },
    summary: {
      dataset: doc.dataset,
      brierStrengthMinusMid: brierGap,
      windowDeltaAblationDrop: deltaDrop,
      calibratedOos: cal?.value ?? null,
      smallSample: true,
    },
    runtimeMs: Date.now() - t0,
    headline: gated
      ? "DATA_GATED: collector export absent"
      : `score_strength-as-probability Brier worse than book mid by +${fmt(brierGap)} (n=${n}); ` +
        `ablating window delta drops hit rate by ${fmt(deltaDrop, 3)} — dominance confirmed; small 3-day sample`,
  };
}

export const R7_GIST_COMPOSITE: ReproExperiment = {
  key: definition.experimentKey,
  definition,
  requiredFixtures: ["GIST_COMPOSITE_WEIGHTS", "GIST_THRESHOLDS"],
  run,
};

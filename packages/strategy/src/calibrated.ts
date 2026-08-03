import { readFileSync } from "node:fs";
import { clampProb, type Prob6, type ProbabilityEstimate } from "@b5p/domain";
import {
  applyCalibration, evaluatePromotion, parseCalibrationArtifact, promotionEvidenceFromArtifact,
  selectedFit, type CalibrationArtifact, type StrategyPromotionDecision,
} from "@b5p/experiments";
import type { FeatureSet } from "./features";
import type { ProbabilityModel } from "./models";

/**
 * Calibrated logistic model, backed by a SEALED CalibrationArtifact emitted by
 * the Python trainer (apps/research/py/train_calibrated_model.py).
 *
 * Approval ladder — evidence, not assertion:
 *   approvedForPaper — true ONLY when a hash-valid artifact is loaded AND every
 *                      feature it names is computable from the live FeatureSet.
 *   approvedForLive  — true ONLY when, additionally, a PASSING persisted
 *                      StrategyPromotionDecision exists for this exact artifact
 *                      (matching id + version) AND that decision re-derives as
 *                      approved from the artifact's own evidence. A persisted
 *                      row that merely CLAIMS approved:true is not trusted.
 *
 * Without an artifact this model estimates nothing and approves nothing —
 * identical to the deliberately-empty placeholder it replaces.
 */

/**
 * Feature extractors: artifact featureNames -> live FeatureSet values. The
 * trainer must restrict an exported artifact's features to THIS vocabulary;
 * an artifact naming anything else is refused at load (a model scored on
 * differently-computed features than it was trained on is silent drift).
 */
export const CALIBRATED_FEATURE_EXTRACTORS: Record<string, (f: FeatureSet) => number | null> = {
  /** UP-token book midpoint (same quantity as the trainer's `mid`). */
  mid: (f) => f.upMid,
  /** UP-token top-of-book spread. */
  spread: (f) => f.upSpread,
  /** mid − 0.5 (the trainer's `dist_half`). */
  dist_half: (f) => (f.upMid === null ? null : f.upMid - 0.5),
  /** 1 when the market closes on a quarter-hour boundary. */
  quarter: (f) => (f.quarterHourClose ? 1 : 0),
  /** Complement dislocation |up + down asks/bids − 1| aggregate. */
  complement_inconsistency: (f) => f.complementInconsistency,
  /** Chainlink distance in vol-standardized units. */
  distance_z: (f) => f.distanceZ,
  /** Seconds to resolution at decision time. */
  seconds_remaining: (f) => f.secondsRemaining,
};

export interface CalibratedModelOptions {
  /** Direct artifact JSON text (tests / in-memory). Wins over paths. */
  artifactText?: string | null;
  /** Path to a sealed artifact JSON file. */
  artifactPath?: string | null;
  /** Persisted promotion decision (or path to its JSON). */
  promotion?: StrategyPromotionDecision | null;
  promotionPath?: string | null;
  /** Env fallbacks used when neither text nor path given (default true). */
  useEnv?: boolean;
}

export interface CalibratedModelState {
  artifact: CalibrationArtifact | null;
  /** Every reason the artifact was refused; null when loaded clean. */
  loadError: string | null;
  promotion: StrategyPromotionDecision | null;
  promotionError: string | null;
}

export const ARTIFACT_PATH_ENV = "B5P_CALIBRATED_ARTIFACT_PATH";
export const PROMOTION_PATH_ENV = "B5P_PROMOTION_DECISION_PATH";

function readTextIfPresent(path: string | null | undefined): { text: string | null; error: string | null } {
  if (!path) return { text: null, error: null };
  try {
    return { text: readFileSync(path, "utf8"), error: null };
  } catch (e) {
    return { text: null, error: `cannot read ${path}: ${(e as Error).message}` };
  }
}

function loadArtifact(opts: CalibratedModelOptions): { artifact: CalibrationArtifact | null; loadError: string | null } {
  let text = opts.artifactText ?? null;
  let readError: string | null = null;
  if (text === null) {
    const path = opts.artifactPath ?? ((opts.useEnv ?? true) ? process.env[ARTIFACT_PATH_ENV] ?? null : null);
    if (path === null) return { artifact: null, loadError: null }; // honestly absent, not an error
    const r = readTextIfPresent(path);
    text = r.text;
    readError = r.error;
  }
  if (text === null) return { artifact: null, loadError: readError };

  const parsed = parseCalibrationArtifact(text);
  if (!parsed.ok) return { artifact: null, loadError: parsed.reasons.join("; ") };
  const artifact = parsed.artifact!;

  if (artifact.kind !== "logistic") {
    return { artifact: null, loadError: `artifact kind "${artifact.kind}" is research-only; runtime scoring requires logistic coefficients` };
  }
  const unmapped = artifact.featureNames.filter((n) => !(n in CALIBRATED_FEATURE_EXTRACTORS));
  if (unmapped.length > 0) {
    return { artifact: null, loadError: `artifact names features with no live extractor: ${unmapped.join(", ")} — refusing to score on drifted features` };
  }
  return { artifact, loadError: null };
}

function loadPromotion(
  opts: CalibratedModelOptions,
  artifact: CalibrationArtifact | null,
): { promotion: StrategyPromotionDecision | null; promotionError: string | null; live: boolean } {
  let decision = opts.promotion ?? null;
  if (decision === null) {
    const path = opts.promotionPath ?? ((opts.useEnv ?? true) ? process.env[PROMOTION_PATH_ENV] ?? null : null);
    if (path !== null) {
      const r = readTextIfPresent(path);
      if (r.error) return { promotion: null, promotionError: r.error, live: false };
      if (r.text !== null) {
        try {
          decision = JSON.parse(r.text) as StrategyPromotionDecision;
        } catch (e) {
          return { promotion: null, promotionError: `promotion decision is not valid JSON: ${(e as Error).message}`, live: false };
        }
      }
    }
  }
  if (decision === null) return { promotion: null, promotionError: null, live: false };
  if (artifact === null) return { promotion: decision, promotionError: "promotion decision present but no valid artifact loaded", live: false };

  const reasons: string[] = [];
  if (!decision.approved) reasons.push("decision is not approved");
  if (!decision.active) reasons.push("decision is not active");
  if (decision.mode !== "live") reasons.push(`decision mode is ${decision.mode}, not live`);
  if (decision.calibrationArtifactId !== artifact.id) reasons.push("decision references a different artifact id");
  if (decision.modelVersion !== artifact.version) reasons.push("decision references a different model version");
  // Never trust the persisted verdict: re-derive from the artifact's own evidence.
  if (reasons.length === 0) {
    const rederived = evaluatePromotion(promotionEvidenceFromArtifact(artifact), decision.criteria);
    if (!rederived.approved) reasons.push(`persisted approval does not re-derive: ${rederived.reasons.join("; ")}`);
  }
  return {
    promotion: decision,
    promotionError: reasons.length === 0 ? null : reasons.join("; "),
    live: reasons.length === 0,
  };
}

function toProb6(x: number): Prob6 {
  return clampProb(BigInt(Math.round(x * 1_000_000)));
}

function calibrationBucketOf(f: FeatureSet): string {
  const secBucket = f.secondsRemaining >= 120 ? "120+" : f.secondsRemaining >= 60 ? "60-120" : f.secondsRemaining >= 30 ? "30-60" : "<30";
  const px = f.upMid === null ? "na" : f.upMid < 0.3 ? "lo" : f.upMid < 0.7 ? "mid" : f.upMid < 0.9 ? "hi" : "extreme";
  return `t${secBucket}|p${px}`;
}

export interface CalibratedProbabilityModel extends ProbabilityModel {
  readonly state: CalibratedModelState;
}

/**
 * Build the calibrated logistic model from an artifact (text, path, or env).
 * Deterministic: all IO happens here, `estimate` is pure afterwards.
 */
export function createCalibratedLogisticModel(opts: CalibratedModelOptions = {}): CalibratedProbabilityModel {
  const { artifact, loadError } = loadArtifact(opts);
  const promo = loadPromotion(opts, artifact);
  const state: CalibratedModelState = {
    artifact,
    loadError,
    promotion: promo.promotion,
    promotionError: promo.promotionError,
  };

  const approvedForPaper = artifact !== null;
  const approvedForLive = artifact !== null && promo.live;
  const version = artifact?.version ?? "calibrated_logistic_v0_NO_ARTIFACT";
  const fit = artifact !== null ? selectedFit(artifact) : null;
  // Uncertainty floor: out-of-fold calibration error + model-vs-null Brier gap.
  // The artifact cannot claim to be sharper than its own measured miscalibration.
  const baseUncertainty = artifact !== null && fit !== null
    ? Math.min(0.25, Math.max(0.02, fit.metrics.ece + Math.max(0, artifact.oofModel.brier - artifact.oofMidNull.brier)))
    : 0.25;

  return {
    version,
    approvedForPaper,
    approvedForLive,
    calibrated: artifact !== null,
    state,
    estimate(f: FeatureSet): ProbabilityEstimate | null {
      if (artifact === null || fit === null) return null;
      const coeff = artifact.coefficients!;
      const std = artifact.standardization!;
      let z = coeff.intercept;
      const attributions: Record<string, number> = {};
      for (const name of artifact.featureNames) {
        const x = CALIBRATED_FEATURE_EXTRACTORS[name]!(f);
        if (x === null || !Number.isFinite(x)) return null; // no estimate without its inputs
        const s = std[name]!;
        const contribution = coeff.weights[name]! * ((x - s.mean) / s.std);
        z += contribution;
        attributions[name] = contribution;
      }
      const raw = 1 / (1 + Math.exp(-z));
      const calibrated = applyCalibration(fit, raw);
      const uncertainty = baseUncertainty;
      return {
        modelVersion: version,
        probability: toProb6(calibrated),
        lowerBound: toProb6(calibrated - uncertainty),
        upperBound: toProb6(calibrated + uncertainty),
        calibrationBucket: calibrationBucketOf(f),
        uncertainty,
        dataQualityPenalty: 1 - f.dataQualityScore,
        featureAttributions: { raw, ...attributions },
        approvedForLive,
      };
    },
  };
}

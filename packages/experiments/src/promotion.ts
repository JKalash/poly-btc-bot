import { parseCalibrationArtifact, selectedFit, sha256Hex, type CalibrationArtifact } from "./artifacts";
import type { ExperimentObservation } from "./types";

/**
 * Strategy promotion: the gate between "model exists" and "model may trade".
 * Pure evaluation — the engine consults the PERSISTED decision, never
 * re-derives it silently.
 *
 * Live approval requires ALL of:
 *  - out-of-fold (walk-forward, purged/embargoed) calibration on enough samples
 *  - every friction included in net EV (fees, spread, latency, adverse selection)
 *  - the LOWER bound of the net-EV 95% CI positive — not the mean
 */

export type PromotionMode = "paper" | "shadow" | "live";

export interface PromotionCriteria {
  minSamples: number;
  maxEce: number;
  /** Net EV lower CI must exceed this (per-cost fraction; 0 = break even). */
  minNetEvLowerCi: number;
}

export interface PromotionEvidence {
  walkForward: {
    folds: number;
    brier: number;
    logLoss: number;
    ece: number;
    n: number;
    purged: boolean;
    embargoMs: number;
  };
  /** Net expected value per unit cost, AFTER all frictions. */
  netEvPerCost: { mean: number; ciLo: number; ciHi: number; n: number };
  frictions: {
    feesIncluded: boolean;
    spreadIncluded: boolean;
    latencyIncluded: boolean;
    adverseSelectionIncluded: boolean;
  };
}

export interface PromotionVerdict {
  approved: boolean;
  reasons: string[]; // every failing reason, risk-engine style
}

export function evaluatePromotion(evidence: PromotionEvidence, criteria: PromotionCriteria): PromotionVerdict {
  const reasons: string[] = [];
  const wf = evidence.walkForward;
  if (wf.folds < 2) reasons.push(`walk-forward evidence has ${wf.folds} fold(s); at least 2 required`);
  if (!wf.purged) reasons.push("walk-forward folds were not purged; leakage cannot be ruled out");
  if (wf.n < criteria.minSamples) reasons.push(`calibration sample count ${wf.n} below required ${criteria.minSamples}`);
  if (!Number.isFinite(wf.ece)) reasons.push("calibration error (ECE) is not a finite number");
  else if (wf.ece > criteria.maxEce) reasons.push(`calibration error ECE ${wf.ece.toFixed(4)} exceeds maximum ${criteria.maxEce}`);
  const fr = evidence.frictions;
  if (!fr.feesIncluded) reasons.push("net EV does not include fees");
  if (!fr.spreadIncluded) reasons.push("net EV does not include spread cost");
  if (!fr.latencyIncluded) reasons.push("net EV does not include latency cost");
  if (!fr.adverseSelectionIncluded) reasons.push("net EV does not include adverse-selection cost");
  const ev = evidence.netEvPerCost;
  if (ev.n < criteria.minSamples) reasons.push(`net-EV sample count ${ev.n} below required ${criteria.minSamples}`);
  if (!Number.isFinite(ev.ciLo)) reasons.push("net-EV lower confidence bound is not a finite number");
  else if (ev.ciLo <= criteria.minNetEvLowerCi) {
    reasons.push(
      `net-EV lower 95% CI ${ev.ciLo.toFixed(4)} does not exceed ${criteria.minNetEvLowerCi} — a positive MEAN (${ev.mean.toFixed(4)}) is not sufficient`,
    );
  }
  return { approved: reasons.length === 0, reasons };
}

/** The persisted decision row shape (mirrored by db strategy_promotion_decisions). */
export interface StrategyPromotionDecision {
  id: string;
  strategyVersion: string;
  modelVersion: string;
  mode: PromotionMode;
  approved: boolean;
  reasons: string[];
  evidence: PromotionEvidence;
  criteria: PromotionCriteria;
  calibrationArtifactId: string | null;
  decidedBy: string;
  decidedAtMs: number;
  active: boolean;
}

/* ------------------------------------------------------------------------ *
 * Artifact-driven promotion: the gate consumes the SEALED trainer artifact,
 * never hand-typed evidence. A missing or tampered artifact is a failing
 * decision with reasons — not an exception and not a silent pass.
 * ------------------------------------------------------------------------ */

export const DEFAULT_PROMOTION_CRITERIA: PromotionCriteria = {
  minSamples: 300,
  maxEce: 0.05,
  minNetEvLowerCi: 0,
};

const nn = (x: number | null | undefined): number => (x === null || x === undefined ? NaN : x);

/** Derive PromotionEvidence from a (verified) artifact. Pure. */
export function promotionEvidenceFromArtifact(artifact: CalibrationArtifact): PromotionEvidence {
  const fit = selectedFit(artifact);
  return {
    walkForward: {
      folds: artifact.foldsRealized,
      brier: fit.metrics.brier,
      logLoss: fit.metrics.logLoss,
      ece: fit.metrics.ece,
      n: fit.metrics.n,
      purged: artifact.foldPlan.purge === true,
      embargoMs: artifact.foldPlan.embargoMs,
    },
    netEvPerCost: {
      mean: nn(artifact.netEv.perCost.mean),
      ciLo: nn(artifact.netEv.perCost.ciLo),
      ciHi: nn(artifact.netEv.perCost.ciHi),
      n: artifact.netEv.perCost.n,
    },
    frictions: {
      feesIncluded: artifact.netEv.frictions.feeRate > 0,
      spreadIncluded: artifact.netEv.frictions.spreadIncluded,
      latencyIncluded: artifact.netEv.frictions.latencyProbPenalty > 0,
      adverseSelectionIncluded: artifact.netEv.frictions.adverseSelectionProbPenalty > 0,
    },
  };
}

const EMPTY_EVIDENCE: PromotionEvidence = {
  walkForward: { folds: 0, brier: NaN, logLoss: NaN, ece: NaN, n: 0, purged: false, embargoMs: 0 },
  netEvPerCost: { mean: NaN, ciLo: NaN, ciHi: NaN, n: 0 },
  frictions: { feesIncluded: false, spreadIncluded: false, latencyIncluded: false, adverseSelectionIncluded: false },
};

export interface ArtifactPromotionInput {
  /** Raw sealed artifact JSON text, or null when no artifact exists. */
  artifactText: string | null;
  /**
   * Supplemental observations (e.g. live-paper fill outcomes). Any net-EV
   * observation must ALSO clear the lower-CI bound — observations can only
   * veto a promotion, never substitute for the artifact.
   */
  observations?: ExperimentObservation[];
  criteria?: PromotionCriteria;
  strategyVersion: string;
  mode: PromotionMode;
  decidedBy: string;
  nowMs: number;
}

const NET_EV_METRICS = new Set(["net_ev_per_cost", "net_ev_per_trade"]);

/**
 * Pure promotion decision from a sealed calibration artifact + observations.
 * Passes ONLY with (a) a present, hash-valid walk-forward artifact and
 * (b) a positive LOWER-CI net EV after fees/spread/latency/adverse selection
 * (plus the calibration-quality criteria in `evaluatePromotion`).
 */
export function evaluateArtifactPromotion(input: ArtifactPromotionInput): StrategyPromotionDecision {
  const criteria = input.criteria ?? DEFAULT_PROMOTION_CRITERIA;
  const reasons: string[] = [];
  let artifact: CalibrationArtifact | null = null;
  let evidence = EMPTY_EVIDENCE;

  if (input.artifactText === null) {
    reasons.push("no walk-forward calibration artifact exists — nothing to promote");
  } else {
    const parsed = parseCalibrationArtifact(input.artifactText);
    if (!parsed.ok) {
      reasons.push(...parsed.reasons.map((r) => `calibration artifact rejected: ${r}`));
    } else {
      artifact = parsed.artifact!;
      evidence = promotionEvidenceFromArtifact(artifact);
      const verdict = evaluatePromotion(evidence, criteria);
      reasons.push(...verdict.reasons);
    }
  }

  for (const obs of input.observations ?? []) {
    if (!NET_EV_METRICS.has(obs.metric)) continue;
    if (obs.ciLo === null || !Number.isFinite(obs.ciLo)) {
      reasons.push(`observation ${obs.metric}/${obs.scope} lacks a finite lower confidence bound`);
    } else if (obs.ciLo <= criteria.minNetEvLowerCi) {
      reasons.push(
        `observation ${obs.metric}/${obs.scope} lower CI ${obs.ciLo.toFixed(4)} does not exceed ${criteria.minNetEvLowerCi}`,
      );
    }
  }

  const idSeed = artifact?.artifactChecksum ?? sha256Hex(input.artifactText ?? "absent");
  return {
    id: `spd-${input.mode}-${idSeed.slice(0, 12)}-${input.nowMs}`,
    strategyVersion: input.strategyVersion,
    modelVersion: artifact?.version ?? "none",
    mode: input.mode,
    approved: reasons.length === 0,
    reasons,
    evidence,
    criteria,
    calibrationArtifactId: artifact?.id ?? null,
    decidedBy: input.decidedBy,
    decidedAtMs: input.nowMs,
    active: true,
  };
}

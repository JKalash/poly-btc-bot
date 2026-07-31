import { clampProb, ONE, prob, type Prob6, type ProbabilityEstimate } from "@b5p/domain";
import type { FeatureSet } from "./features";

/**
 * Probability models.
 *
 * Three quantities are kept distinct everywhere:
 *   market_probability      — executable price / book-derived probability
 *   model_probability       — calibrated estimate of resolution probability
 *   conservative_probability— lower-confidence estimate after penalties
 *
 * HONESTY CONSTRAINT: no model in this build is calibrated on out-of-sample
 * fills, so NO model is approved for live use. The book baseline is the null
 * model (its probability IS the market price, so it can never show edge by
 * construction). The distance/vol heuristic is explicitly UNCALIBRATED and
 * usable in paper/observe only. This is by design: the system must refuse to
 * trade until a walk-forward-validated calibration artifact exists.
 */

export interface ProbabilityModel {
  version: string;
  approvedForLive: boolean;
  approvedForPaper: boolean;
  estimate(f: FeatureSet): ProbabilityEstimate | null;
}

function calibrationBucket(f: FeatureSet): string {
  const secBucket = f.secondsRemaining >= 120 ? "120+" : f.secondsRemaining >= 60 ? "60-120" : f.secondsRemaining >= 30 ? "30-60" : "<30";
  const px = f.upMid === null ? "na" : f.upMid < 0.3 ? "lo" : f.upMid < 0.7 ? "mid" : f.upMid < 0.9 ? "hi" : "extreme";
  return `t${secBucket}|p${px}`;
}

function toProb6(x: number): Prob6 {
  return clampProb(BigInt(Math.round(x * 1_000_000)));
}

/**
 * Book-only baseline: probability = de-biased book midpoint (UP token).
 * Uncertainty = half-spread + complement inconsistency. This is the null
 * model against which any claimed edge must be compared.
 */
export const bookBaselineModel: ProbabilityModel = {
  version: "book_baseline_v1",
  approvedForLive: false,
  approvedForPaper: true,
  estimate(f: FeatureSet): ProbabilityEstimate | null {
    if (f.upMid === null || f.upSpread === null) return null;
    const halfSpread = f.upSpread / 2;
    const incons = f.complementInconsistency ?? 0.01;
    const uncertainty = Math.min(0.2, halfSpread + incons);
    const penalty = 1 - f.dataQualityScore;
    const p = toProb6(f.upMid);
    return {
      modelVersion: this.version,
      probability: p,
      lowerBound: toProb6(f.upMid - uncertainty),
      upperBound: toProb6(f.upMid + uncertainty),
      calibrationBucket: calibrationBucket(f),
      uncertainty,
      dataQualityPenalty: penalty,
      featureAttributions: { upMid: f.upMid, upSpread: f.upSpread, complementInconsistency: incons },
      approvedForLive: false,
    };
  },
};

/** Student-t CDF with df=3 (closed form) — fat-tailed on purpose; still NOT a calibrated probability. */
export function studentT3Cdf(x: number): number {
  const a = x / Math.sqrt(3);
  return 0.5 + (1 / Math.PI) * (a / (1 + a * a) + Math.atan(a));
}

/**
 * Distance/volatility heuristic: P(final >= priceToBeat) from standardized
 * distance under a t(3) distribution. UNCALIBRATED — paper/observe only.
 * The tie rule (>= resolves Up) means a flat market leans structurally UP,
 * which this captures only through distance >= 0; the residual tie premium is
 * a research question, not an assumed edge.
 */
export const distanceVolHeuristicModel: ProbabilityModel = {
  version: "distance_vol_heuristic_v1_UNCALIBRATED",
  approvedForLive: false,
  approvedForPaper: true,
  estimate(f: FeatureSet): ProbabilityEstimate | null {
    if (f.distanceZ === null || f.estRemainingMoveStdBps === null) return null;
    const pUp = studentT3Cdf(f.distanceZ);
    // Uncertainty: dominated by vol-estimator error; widen by 1/sqrt(effective sample)
    // plus explicit "uncalibrated" penalty that keeps the conservative bound wide.
    const volUncertainty = Math.min(0.25, 0.08 + Math.abs(f.distanceZ) * 0.02);
    const uncalibratedPenalty = 0.05;
    const uncertainty = volUncertainty + uncalibratedPenalty;
    const penalty = 1 - f.dataQualityScore;
    return {
      modelVersion: this.version,
      probability: toProb6(pUp),
      lowerBound: toProb6(pUp - uncertainty),
      upperBound: toProb6(pUp + uncertainty),
      calibrationBucket: calibrationBucket(f),
      uncertainty,
      dataQualityPenalty: penalty,
      featureAttributions: {
        distanceZ: f.distanceZ,
        distanceBps: f.distanceBps ?? 0,
        estRemainingMoveStdBps: f.estRemainingMoveStdBps,
        velocityBpsPerSec: f.velocityBpsPerSec ?? 0,
      },
      approvedForLive: false,
    };
  },
};

/**
 * Placeholder for the calibrated logistic model. Refuses to produce estimates
 * until a walk-forward validation artifact exists (created by apps/research,
 * never automatically).
 */
export const calibratedLogisticModel: ProbabilityModel = {
  version: "calibrated_logistic_v0_NO_ARTIFACT",
  approvedForLive: false,
  approvedForPaper: false,
  estimate(): ProbabilityEstimate | null {
    return null; // no calibration artifact in this build
  },
};

/**
 * Composite-indicator model (gist integration). Maps the weighted indicator
 * score to a probability through a fixed logistic squash. The mapping is a
 * GUESS, not a calibration — hence UNCALIBRATED, paper/shadow only, and the
 * uncertainty band is kept wide until research produces a calibration curve
 * of realized outcome frequency vs composite score.
 */
export const binanceCompositeModel: ProbabilityModel = {
  version: "binance_composite_v1_UNCALIBRATED",
  approvedForLive: false,
  approvedForPaper: true,
  estimate(f: FeatureSet): ProbabilityEstimate | null {
    const ind = f.indicators;
    if (!ind || ind.direction === null) return null;
    const pUp = 1 / (1 + Math.exp(-3 * ind.compositeScore));
    const uncertainty = 0.12 + 0.05; // score-mapping guess + uncalibrated penalty
    return {
      modelVersion: this.version,
      probability: toProb6(pUp),
      lowerBound: toProb6(pUp - uncertainty),
      upperBound: toProb6(pUp + uncertainty),
      calibrationBucket: calibrationBucket(f),
      uncertainty,
      dataQualityPenalty: 1 - f.dataQualityScore,
      featureAttributions: {
        compositeScore: ind.compositeScore,
        windowDeltaPct: ind.windowDeltaPct ?? 0,
        microMomentumPct: ind.microMomentumPct ?? 0,
        accelerationPct: ind.accelerationPct ?? 0,
        emaCrossSignal: ind.emaCrossSignal ?? 0,
        rsi: ind.rsi ?? 50,
        volumeSurgeRatio: ind.volumeSurgeRatio ?? 1,
        tickTrend: ind.tickTrend ?? 0,
      },
      approvedForLive: false,
    };
  },
};

export const MODELS: Record<string, ProbabilityModel> = {
  book_baseline: bookBaselineModel,
  distance_vol_heuristic: distanceVolHeuristicModel,
  binance_composite: binanceCompositeModel,
  calibrated_logistic: calibratedLogisticModel,
};

/**
 * Conservative probability for a given side: the side-adjusted lower bound
 * minus the data-quality penalty (scaled). This is what the risk engine and
 * Kelly sizing see — never the point estimate.
 */
export function conservativeProbabilityForSide(est: ProbabilityEstimate, side: "UP" | "DOWN"): Prob6 {
  const pSide = side === "UP" ? est.probability : ONE - est.probability;
  const lower = side === "UP" ? est.lowerBound : ONE - est.upperBound;
  const penalty6 = BigInt(Math.round(est.dataQualityPenalty * 100_000)); // up to 0.1 in prob
  const v = (lower < pSide ? lower : pSide) - penalty6;
  return v < 0n ? 0n : v;
}

export { prob as probOf };

/**
 * Scoring metrics for probabilistic predictions. Doubles are acceptable here
 * (research statistics, not money math) — matching @b5p/domain/stats.
 */

export interface ScoredSample {
  /** Predicted probability of the positive outcome, in [0,1]. */
  p: number;
  /** Realized outcome. */
  y: 0 | 1;
}

export function brierScore(samples: ScoredSample[]): number {
  if (samples.length === 0) return NaN;
  let s = 0;
  for (const { p, y } of samples) s += (p - y) ** 2;
  return s / samples.length;
}

const EPS = 1e-15;

export function logLoss(samples: ScoredSample[]): number {
  if (samples.length === 0) return NaN;
  let s = 0;
  for (const { p, y } of samples) {
    const q = Math.min(1 - EPS, Math.max(EPS, p));
    s += y === 1 ? -Math.log(q) : -Math.log(1 - q);
  }
  return s / samples.length;
}

/** Expected calibration error over `bins` equal-count bins (quantile binning). */
export function expectedCalibrationError(samples: ScoredSample[], bins = 10): number {
  const n = samples.length;
  if (n === 0) return NaN;
  const sorted = [...samples].sort((a, b) => a.p - b.p);
  const nBins = Math.min(bins, n);
  let ece = 0;
  for (let b = 0; b < nBins; b++) {
    const lo = Math.floor((b * n) / nBins);
    const hi = Math.floor(((b + 1) * n) / nBins);
    if (hi <= lo) continue;
    const slice = sorted.slice(lo, hi);
    const meanP = slice.reduce((s, x) => s + x.p, 0) / slice.length;
    const meanY = slice.reduce((s, x) => s + x.y, 0) / slice.length;
    ece += (slice.length / n) * Math.abs(meanP - meanY);
  }
  return ece;
}

/** Normal-approximation 95% CI for a sample mean. */
export function meanCi95(xs: number[]): { mean: number; lo: number; hi: number; n: number } {
  const n = xs.length;
  if (n === 0) return { mean: NaN, lo: NaN, hi: NaN, n: 0 };
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  if (n === 1) return { mean, lo: -Infinity, hi: Infinity, n };
  const varSum = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  const se = Math.sqrt(varSum / n);
  const z = 1.959963985;
  return { mean, lo: mean - z * se, hi: mean + z * se, n };
}

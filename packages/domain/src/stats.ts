/**
 * Research statistics. These operate on counts and produce display/report
 * values; double precision is acceptable here (not money math).
 */

/** Standard normal CDF via Abramowitz–Stegun 7.1.26 erf approximation (|err| < 1.5e-7). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y =
    t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) *
    Math.exp((-x * x) / 2);
  return x >= 0 ? 1 - y / 2 : y / 2;
}

/** Wilson score interval for k successes in n trials. */
export function wilsonInterval(k: number, n: number, z = 1.959963985): { lo: number; hi: number; p: number } {
  if (n === 0) return { lo: 0, hi: 1, p: NaN };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half), p };
}

/** Two-proportion z-test (pooled). Returns z and two-sided p. */
export function twoProportionTest(k1: number, n1: number, k2: number, n2: number): { z: number; p: number } {
  if (n1 === 0 || n2 === 0) return { z: 0, p: 1 };
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const pool = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(pool * (1 - pool) * (1 / n1 + 1 / n2));
  if (se === 0) return { z: 0, p: 1 };
  const z = (p1 - p2) / se;
  return { z, p: 2 * (1 - normCdf(Math.abs(z))) };
}

/** One-sample binomial vs p0, normal approximation, two-sided. */
export function binomialTest(k: number, n: number, p0 = 0.5): { z: number; p: number } {
  if (n === 0) return { z: 0, p: 1 };
  const se = Math.sqrt((p0 * (1 - p0)) / n);
  const z = (k / n - p0) / se;
  return { z, p: 2 * (1 - normCdf(Math.abs(z))) };
}

/** Regularized upper incomplete gamma Q(a, x) — series + continued fraction (NR style). */
function gammaQ(a: number, x: number): number {
  if (x < 0 || a <= 0) return NaN;
  if (x === 0) return 1;
  const gln = lnGamma(a);
  if (x < a + 1) {
    // series for P(a,x)
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let i = 0; i < 500; i++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  // continued fraction for Q(a,x)
  let b = x + 1 - a;
  let c = 1e300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return h * Math.exp(-x + a * Math.log(x) - gln);
}

function lnGamma(x: number): number {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of cof) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Chi-square survival function P(X >= x) with df degrees of freedom. */
export function chiSquareSf(x: number, df: number): number {
  return gammaQ(df / 2, x / 2);
}

/** Pearson chi-square goodness-of-fit for equal-probability buckets of successes vs failures. */
export function chiSquareUpDownBuckets(buckets: Array<{ up: number; n: number }>): { chi2: number; df: number; p: number } {
  const totalUp = buckets.reduce((s, b) => s + b.up, 0);
  const totalN = buckets.reduce((s, b) => s + b.n, 0);
  if (totalN === 0) return { chi2: 0, df: 0, p: 1 };
  const pHat = totalUp / totalN;
  let chi2 = 0;
  for (const b of buckets) {
    const eUp = b.n * pHat;
    const eDown = b.n * (1 - pHat);
    if (eUp > 0) chi2 += (b.up - eUp) ** 2 / eUp;
    if (eDown > 0) chi2 += (b.n - b.up - eDown) ** 2 / eDown;
  }
  const df = buckets.length - 1;
  return { chi2, df, p: chiSquareSf(chi2, df) };
}

export const bonferroni = (p: number, m: number): number => Math.min(1, p * m);

/** Benjamini–Hochberg adjusted p-values (returned in input order). */
export function benjaminiHochberg(ps: number[]): number[] {
  const m = ps.length;
  const idx = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
  const adj = new Array<number>(m);
  let prev = 1;
  for (let rank = m; rank >= 1; rank--) {
    const [p, orig] = idx[rank - 1]!;
    prev = Math.min(prev, (p * m) / rank);
    adj[orig] = Math.min(1, prev);
  }
  return adj;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

/** Mann-Whitney U (rank-sum) two-sided normal approximation with tie correction. */
export function mannWhitney(a: number[], b: number[]): { u: number; z: number; p: number } {
  const n1 = a.length, n2 = b.length;
  if (n1 === 0 || n2 === 0) return { u: 0, z: 0, p: 1 };
  const all = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))].sort((x, y) => x.v - y.v);
  const ranks = new Array<number>(all.length);
  const tieGroups: number[] = [];
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j < all.length - 1 && all[j + 1]!.v === all[i]!.v) j++;
    const r = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) ranks[k] = r;
    if (j > i) tieGroups.push(j - i + 1);
    i = j + 1;
  }
  let r1 = 0;
  all.forEach((x, i) => { if (x.g === 0) r1 += ranks[i]!; });
  const u1 = r1 - (n1 * (n1 + 1)) / 2;
  const mu = (n1 * n2) / 2;
  const n = n1 + n2;
  const tieCorr = tieGroups.reduce((s, t) => s + (t ** 3 - t), 0);
  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tieCorr / (n * (n - 1))));
  if (sigma === 0) return { u: u1, z: 0, p: 1 };
  const z = (u1 - mu) / sigma;
  return { u: u1, z, p: 2 * (1 - normCdf(Math.abs(z))) };
}

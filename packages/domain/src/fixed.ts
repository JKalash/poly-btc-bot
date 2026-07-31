/**
 * Exact fixed-point arithmetic for money, shares and probabilities.
 *
 * All economic quantities are integers:
 *  - Usdc6:   micro-USDC            (1 USDC   = 1_000_000n)
 *  - Shares6: micro-shares          (1 share  = 1_000_000n)
 *  - Prob6:   micro-probability     (100%     = 1_000_000n); prices of binary
 *             outcomes are probabilities in [0, 1_000_000].
 *  - Ppm:     parts-per-million rates (7% fee = 70_000)
 *
 * Binary floating point is never used for order construction, fees, balances
 * or P&L. Floats are permitted only for display and for statistical features.
 */

export type Usdc6 = bigint;
export type Shares6 = bigint;
export type Prob6 = bigint;
export type Ppm = bigint;

export const ONE = 1_000_000n;
export const PPM = 1_000_000n;

export type Rounding = "floor" | "ceil" | "half-even";

/** (a * b) / d with explicit rounding. Exact in bigint space. */
export function mulDiv(a: bigint, b: bigint, d: bigint, mode: Rounding = "floor"): bigint {
  if (d === 0n) throw new Error("mulDiv: division by zero");
  const neg = (a < 0n) !== (b < 0n) !== (d < 0n);
  const n = (a < 0n ? -a : a) * (b < 0n ? -b : b);
  const den = d < 0n ? -d : d;
  let q = n / den;
  const r = n % den;
  if (r !== 0n) {
    if (mode === "ceil" && !neg) q += 1n;
    if (mode === "floor" && neg) q += 1n; // magnitude rounds toward zero handled below by sign flip
    if (mode === "half-even") {
      const twice = r * 2n;
      if (twice > den || (twice === den && q % 2n === 1n)) q += 1n;
    }
  }
  return neg ? -q : q;
}

/** Parse a decimal string ("0.95", "64721.25") into a scaled bigint with `decimals` places. Exact; throws on more precision than `decimals`. */
export function parseFixed(s: string, decimals: number, opts: { truncateExtra?: boolean } = {}): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`parseFixed: invalid decimal string ${JSON.stringify(s)}`);
  const sign = m[1]!;
  const intPart = m[2]!;
  let frac = m[3] ?? "";
  if (frac.length > decimals) {
    if (!opts.truncateExtra && /[1-9]/.test(frac.slice(decimals))) {
      throw new Error(`parseFixed: ${s} exceeds ${decimals} decimal places`);
    }
    frac = frac.slice(0, decimals);
  }
  const scaled = BigInt(intPart) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  return sign === "-" ? -scaled : scaled;
}

export function formatFixed(v: bigint, decimals: number, trim = true): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const i = abs / base;
  let f = (abs % base).toString().padStart(decimals, "0");
  if (trim) f = f.replace(/0+$/, "");
  return `${neg ? "-" : ""}${i}${f ? "." + f : ""}`;
}

export const usdc = (s: string): Usdc6 => parseFixed(s, 6);
export const shares = (s: string): Shares6 => parseFixed(s, 6);
/** Price/probability from decimal string, e.g. "0.95" -> 950_000n */
export const prob = (s: string): Prob6 => {
  const p = parseFixed(s, 6);
  if (p < 0n || p > ONE) throw new Error(`prob out of [0,1]: ${s}`);
  return p;
};
export const ppm = (s: string): Ppm => parseFixed(s, 6);

export const fmtUsdc = (v: Usdc6): string => formatFixed(v, 6);
export const fmtProb = (v: Prob6): string => formatFixed(v, 6);
export const fmtShares = (v: Shares6): string => formatFixed(v, 6);

/** Display helper only — never feed back into economic math. */
export const toNumber = (v: bigint, decimals = 6): number => Number(v) / 10 ** decimals;

export function assertProb(p: Prob6, label = "probability"): void {
  if (p < 0n || p > ONE) throw new Error(`${label} out of range [0,1]: ${p}`);
}

export function clampProb(p: Prob6): Prob6 {
  return p < 0n ? 0n : p > ONE ? ONE : p;
}

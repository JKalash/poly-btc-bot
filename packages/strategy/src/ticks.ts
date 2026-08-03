import type { ReferenceTick } from "@b5p/domain";

/**
 * Rolling buffer of reference-price ticks with windowed feature queries.
 * Feature math uses floats (statistical, not monetary). Exact values for
 * settlement come from the stored tick strings, not from here.
 */
export class TickBuffer {
  private ticks: ReferenceTick[] = [];
  constructor(private readonly maxAgeMs: number = 10 * 60 * 1000) {}

  push(t: ReferenceTick): void {
    const last = this.ticks[this.ticks.length - 1];
    if (last && t.sourceTsMs <= last.sourceTsMs) {
      // Overlap region — RTDS replays a backfill array on every (re)subscribe.
      // Drop exact duplicates, or the zero-gaps collapse medianGapMs to 0 for
      // 10 minutes after each reconnect, masking real cadence degradation.
      for (let i = this.ticks.length - 1; i >= 0; i--) {
        const e = this.ticks[i]!;
        if (e.sourceTsMs < t.sourceTsMs) break;
        if (e.sourceTsMs === t.sourceTsMs && e.value === t.value) return;
      }
      // genuinely new out-of-order tick: keep, but maintain sort
      this.ticks.push(t);
      this.ticks.sort((a, b) => a.sourceTsMs - b.sourceTsMs);
    } else {
      this.ticks.push(t);
    }
    const cutoff = t.sourceTsMs - this.maxAgeMs;
    let drop = 0;
    while (drop < this.ticks.length && this.ticks[drop]!.sourceTsMs < cutoff) drop++;
    if (drop > 0) this.ticks.splice(0, drop);
  }

  get size(): number { return this.ticks.length; }

  latest(): ReferenceTick | null {
    return this.ticks[this.ticks.length - 1] ?? null;
  }

  /** Last tick at or before ts (for boundary/price-to-beat capture). */
  atOrBefore(tsMs: number): ReferenceTick | null {
    for (let i = this.ticks.length - 1; i >= 0; i--) {
      if (this.ticks[i]!.sourceTsMs <= tsMs) return this.ticks[i]!;
    }
    return null;
  }

  window(nowMs: number, windowMs: number): ReferenceTick[] {
    const from = nowMs - windowMs;
    return this.ticks.filter((t) => t.sourceTsMs >= from && t.sourceTsMs <= nowMs);
  }

  /** Annualization-free realized vol: std of log returns over the window, scaled to the window length. Returned in bps of price. */
  realizedVolBps(nowMs: number, windowMs: number): number | null {
    const w = this.window(nowMs, windowMs);
    if (w.length < 3) return null;
    const rets: number[] = [];
    for (let i = 1; i < w.length; i++) {
      const a = w[i - 1]!.value;
      const b = w[i]!.value;
      if (a > 0 && b > 0) rets.push(Math.log(b / a));
    }
    if (rets.length < 2) return null;
    const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
    const varr = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1);
    // scale per-tick variance to the whole window by tick count
    return Math.sqrt(varr * rets.length) * 10_000;
  }

  /** EWMA volatility of log returns with half-life, in bps per sqrt(second). */
  ewmaVolBpsPerSqrtSec(nowMs: number, halfLifeMs: number, lookbackMs = 5 * 60 * 1000): number | null {
    const w = this.window(nowMs, lookbackMs);
    if (w.length < 5) return null;
    const lambda = Math.exp(Math.log(0.5) / (halfLifeMs / 1000));
    let ewvar = 0;
    let initialized = false;
    for (let i = 1; i < w.length; i++) {
      const a = w[i - 1]!;
      const b = w[i]!;
      const dt = Math.max(0.001, (b.sourceTsMs - a.sourceTsMs) / 1000);
      if (a.value <= 0 || b.value <= 0) continue;
      const r2PerSec = Math.log(b.value / a.value) ** 2 / dt;
      if (!initialized) { ewvar = r2PerSec; initialized = true; continue; }
      const l = Math.pow(lambda, dt);
      ewvar = l * ewvar + (1 - l) * r2PerSec;
    }
    if (!initialized) return null;
    return Math.sqrt(ewvar) * 10_000;
  }

  highLowRange(nowMs: number, windowMs: number): { high: number; low: number; rangeBps: number } | null {
    const w = this.window(nowMs, windowMs);
    if (w.length < 2) return null;
    let high = -Infinity;
    let low = Infinity;
    for (const t of w) { if (t.value > high) high = t.value; if (t.value < low) low = t.value; }
    return { high, low, rangeBps: low > 0 ? ((high - low) / low) * 10_000 : 0 };
  }

  /** Threshold crossings against a reference level within the window. */
  crossings(nowMs: number, windowMs: number, level: number): { count: number; lastCrossAgoMs: number | null; minAbsDistanceBps: number | null } {
    const w = this.window(nowMs, windowMs);
    let count = 0;
    let lastCrossTs: number | null = null;
    let minAbs = Infinity;
    for (let i = 0; i < w.length; i++) {
      const d = w[i]!.value - level;
      if (level > 0) minAbs = Math.min(minAbs, Math.abs(d) / level * 10_000);
      if (i > 0) {
        const prev = w[i - 1]!.value - level;
        if ((prev < 0 && d >= 0) || (prev >= 0 && d < 0)) {
          count++;
          lastCrossTs = w[i]!.sourceTsMs;
        }
      }
    }
    return {
      count,
      lastCrossAgoMs: lastCrossTs === null ? null : nowMs - lastCrossTs,
      minAbsDistanceBps: Number.isFinite(minAbs) ? minAbs : null,
    };
  }

  /** Velocity (bps/s over ~lookback) and acceleration (difference of half-window velocities). */
  velocityBpsPerSec(nowMs: number, lookbackMs: number): { velocity: number | null; acceleration: number | null } {
    const w = this.window(nowMs, lookbackMs);
    if (w.length < 3) return { velocity: null, acceleration: null };
    const first = w[0]!;
    const last = w[w.length - 1]!;
    const dt = (last.sourceTsMs - first.sourceTsMs) / 1000;
    if (dt <= 0 || first.value <= 0) return { velocity: null, acceleration: null };
    const velocity = ((last.value - first.value) / first.value) * 10_000 / dt;
    const midTs = nowMs - lookbackMs / 2;
    const firstHalf = w.filter((t) => t.sourceTsMs <= midTs);
    const secondHalf = w.filter((t) => t.sourceTsMs > midTs);
    let acceleration: number | null = null;
    if (firstHalf.length >= 2 && secondHalf.length >= 2) {
      const v1 = segVel(firstHalf);
      const v2 = segVel(secondHalf);
      if (v1 !== null && v2 !== null) acceleration = (v2 - v1) / (lookbackMs / 2000);
    }
    return { velocity, acceleration };
  }

  /** Median inter-tick gap (feed cadence health). */
  medianGapMs(nowMs: number, windowMs: number): number | null {
    const w = this.window(nowMs, windowMs);
    if (w.length < 3) return null;
    const gaps: number[] = [];
    for (let i = 1; i < w.length; i++) gaps.push(w[i]!.sourceTsMs - w[i - 1]!.sourceTsMs);
    gaps.sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)]!;
  }

  maxGapMs(nowMs: number, windowMs: number): number | null {
    const w = this.window(nowMs, windowMs);
    if (w.length < 2) return null;
    let mx = 0;
    for (let i = 1; i < w.length; i++) mx = Math.max(mx, w[i]!.sourceTsMs - w[i - 1]!.sourceTsMs);
    return mx;
  }
}

function segVel(seg: { sourceTsMs: number; value: number }[]): number | null {
  const a = seg[0]!;
  const b = seg[seg.length - 1]!;
  const dt = (b.sourceTsMs - a.sourceTsMs) / 1000;
  if (dt <= 0 || a.value <= 0) return null;
  return ((b.value - a.value) / a.value) * 10_000 / dt;
}

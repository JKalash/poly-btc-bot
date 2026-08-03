import type { OutcomeSide } from "@b5p/domain";
import { TickBuffer } from "./ticks";

/**
 * Composite indicator strategy adapted from the operator's PolymarketBot gist.
 *
 * Seven indicators; "window delta" (move since the market window opened)
 * carries the dominant weight because it directly answers the market's
 * question. IMPORTANT DIFFERENCES from the gist, by design:
 *  - Indicators are computed from Binance data but direction must still be
 *    CONFIRMED by the authoritative Chainlink distance (markets resolve on
 *    Chainlink, and near the boundary the two feeds can disagree).
 *  - The composite score is a SIGNAL, not a probability. It feeds an
 *    explicitly uncalibrated model that can never be live-approved until a
 *    walk-forward calibration artifact exists.
 *  - The gist's all-in ("degen") sizing is not integrated into any armed
 *    path; it exists only as a paper-mode ruin simulation.
 */

export interface Candle {
  openTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Provenance of the 1s candles the indicators were computed from. */
export type CandleSource = "BINANCE_KLINES" | "CHAINLINK_SYNTHETIC";

export interface IndicatorBlock {
  candleSource: CandleSource;         // provenance: which feed produced the candles
  windowDeltaPct: number | null;      // % move from window open to now (dominant)
  microMomentumPct: number | null;    // % move over last 30s
  accelerationPct: number | null;     // momentum change: last 15s vs prior 15s
  emaCrossSignal: number | null;      // sign(EMA9 - EMA21) * normalized magnitude, 1s candles
  rsi: number | null;                 // RSI(14) on 15s aggregated closes
  volumeSurgeRatio: number | null;    // last 10s volume vs trailing avg 10s volume
  tickTrend: number | null;           // fraction of up-ticks in last 20 RTDS ticks, centered
  compositeScore: number;             // weighted sum in [-1, 1] approx
  confidence: number;                 // |score| clipped to [0, 1]
  direction: OutcomeSide | null;      // sign of score; null when flat
  weightsVersion: string;
}

export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i]! * k + e * (1 - k);
  return e;
}

export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
  }
  if (avgGain === 0 && avgLoss === 0) return 50; // flat tape is neutral, not overbought
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** Aggregate 1s candles into N-second candles (close-only list). */
export function aggregateCloses(candles: Candle[], seconds: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < candles.length; i += seconds) {
    const chunk = candles.slice(i, i + seconds);
    if (chunk.length > 0) out.push(chunk[chunk.length - 1]!.close);
  }
  return out;
}

export const COMPOSITE_WEIGHTS = {
  windowDelta: 6,     // gist: 5-7, dominant
  microMomentum: 1,
  acceleration: 1,
  emaCross: 1,
  rsiExtreme: 1,
  volumeSurge: 1,
  tickTrend: 1,
} as const;

export const WEIGHTS_VERSION = "gist_composite_v1";

export interface IndicatorInputs {
  nowMs: number;
  windowStartEpochSec: number;
  candles1s: Candle[];       // 1s candles, oldest first, spanning >= window + lookback
  binanceTicks: TickBuffer;  // tick stream for tick trend (matches candleSource)
  candleSource: CandleSource; // provenance recorded on the output block
}

export function computeIndicators(inp: IndicatorInputs): IndicatorBlock {
  const { candles1s, nowMs } = inp;
  const last = candles1s[candles1s.length - 1] ?? null;
  const price = last?.close ?? null;

  // window delta: move from the candle at/after window start
  const windowStartMs = inp.windowStartEpochSec * 1000;
  const openCandle = candles1s.find((c) => c.openTimeMs >= windowStartMs) ?? null;
  const windowDeltaPct = openCandle && price !== null && openCandle.open > 0
    ? ((price - openCandle.open) / openCandle.open) * 100
    : null;

  const pctMove = (secondsBack: number, endOffset = 0): number | null => {
    const end = candles1s.length - 1 - endOffset;
    const start = end - secondsBack;
    if (start < 0 || end <= start) return null;
    const a = candles1s[start]!.close;
    const b = candles1s[end]!.close;
    return a > 0 ? ((b - a) / a) * 100 : null;
  };

  const microMomentumPct = pctMove(30);
  const m1 = pctMove(15);
  const m2 = pctMove(15, 15);
  const accelerationPct = m1 !== null && m2 !== null ? m1 - m2 : null;

  const closes5s = aggregateCloses(candles1s, 5);
  const e9 = ema(closes5s, 9);
  const e21 = ema(closes5s, 21);
  const emaCrossSignal = e9 !== null && e21 !== null && e21 > 0
    ? Math.tanh(((e9 - e21) / e21) * 10_000 / 5) // ~5bps separation saturates
    : null;

  const closes15s = aggregateCloses(candles1s, 15);
  const rsiVal = rsi(closes15s, 14);

  let volumeSurgeRatio: number | null = null;
  if (candles1s.length >= 70) {
    const last10 = candles1s.slice(-10).reduce((s, c) => s + c.volume, 0);
    const trailing = candles1s.slice(-70, -10);
    const trailingAvg10 = (trailing.reduce((s, c) => s + c.volume, 0) / trailing.length) * 10;
    volumeSurgeRatio = trailingAvg10 > 0 ? last10 / trailingAvg10 : null;
  }

  const recent = inp.binanceTicks.window(nowMs, 30_000).slice(-20);
  let tickTrend: number | null = null;
  if (recent.length >= 6) {
    let ups = 0;
    let moves = 0;
    for (let i = 1; i < recent.length; i++) {
      const d = recent[i]!.value - recent[i - 1]!.value;
      if (d !== 0) { moves++; if (d > 0) ups++; }
    }
    tickTrend = moves > 0 ? (ups / moves) * 2 - 1 : 0;
  }

  // normalize each indicator to [-1, 1]
  const norm = {
    windowDelta: windowDeltaPct === null ? 0 : Math.tanh(windowDeltaPct / 0.05), // 5bps saturates
    microMomentum: microMomentumPct === null ? 0 : Math.tanh(microMomentumPct / 0.03),
    acceleration: accelerationPct === null ? 0 : Math.tanh(accelerationPct / 0.02),
    emaCross: emaCrossSignal ?? 0,
    rsiExtreme: rsiVal === null ? 0 : rsiVal >= 70 ? -((rsiVal - 70) / 30) : rsiVal <= 30 ? (30 - rsiVal) / 30 : 0,
    volumeSurge: 0, // direction-neutral: amplifies below instead of adding
    tickTrend: tickTrend ?? 0,
  };

  const W = COMPOSITE_WEIGHTS;
  const totalWeight = W.windowDelta + W.microMomentum + W.acceleration + W.emaCross + W.rsiExtreme + W.tickTrend;
  let score =
    (W.windowDelta * norm.windowDelta +
      W.microMomentum * norm.microMomentum +
      W.acceleration * norm.acceleration +
      W.emaCross * norm.emaCross +
      W.rsiExtreme * norm.rsiExtreme +
      W.tickTrend * norm.tickTrend) / totalWeight;

  // volume surge amplifies conviction but never creates direction
  if (volumeSurgeRatio !== null && volumeSurgeRatio > 1.5) {
    score *= Math.min(1.25, 1 + (volumeSurgeRatio - 1.5) * 0.1);
    score = Math.max(-1, Math.min(1, score));
  }

  const confidence = Math.min(1, Math.abs(score));
  return {
    candleSource: inp.candleSource,
    windowDeltaPct,
    microMomentumPct,
    accelerationPct,
    emaCrossSignal,
    rsi: rsiVal,
    volumeSurgeRatio,
    tickTrend,
    compositeScore: score,
    confidence,
    direction: score > 0.001 ? "UP" : score < -0.001 ? "DOWN" : null,
    weightsVersion: WEIGHTS_VERSION,
  };
}

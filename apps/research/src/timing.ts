import {
  CLOSING_MINUTE_BUCKETS, benjaminiHochberg, bonferroni, chiSquareUpDownBuckets,
  closingMinuteBucket, isQuarterHourClose, median, quantile, twoProportionTest, wilsonInterval,
} from "@b5p/domain";

/**
 * Timing Lab statistics. Outcomes come from official Gamma resolutions;
 * move magnitudes come from Binance 5m candles (diagnostic only — Binance is
 * never the resolution source). Every p-value is reported raw AND corrected
 * (Bonferroni and Benjamini-Hochberg): outcome skew is not trading edge
 * unless price fails to reflect it.
 */

export interface ResolvedMarketRow {
  endEpoch: number;
  outcome: "UP" | "DOWN";
  volumeUsd: number | null;
  absMoveBps: number | null;
}

export interface BucketStat {
  bucket: string;
  n: number;
  up: number;
  upRate: number;
  wilsonLo: number;
  wilsonHi: number;
  pRaw: number | null;
  pBonferroni: number | null;
  pBh: number | null;
  medianAbsMoveBps: number | null;
  meanAbsMoveBps: number | null;
  p90AbsMoveBps: number | null;
  medianVolume: number | null;
}

export interface TimingRunResult {
  windowDays: number;
  buckets: BucketStat[];   // 12 minute buckets + "quarter" + "other" + "all"
  globalChi2: { chi2: number; df: number; p: number };
  quarterVsOther: { z: number; p: number };
}

export function computeTimingStats(rows: ResolvedMarketRow[], windowDays: number): TimingRunResult {
  const byBucket = new Map<string, ResolvedMarketRow[]>();
  for (const b of CLOSING_MINUTE_BUCKETS) byBucket.set(b, []);
  const quarter: ResolvedMarketRow[] = [];
  const other: ResolvedMarketRow[] = [];
  for (const r of rows) {
    byBucket.get(closingMinuteBucket(r.endEpoch))?.push(r);
    (isQuarterHourClose(r.endEpoch) ? quarter : other).push(r);
  }

  const minuteStatsRaw = CLOSING_MINUTE_BUCKETS.map((bucket) => {
    const list = byBucket.get(bucket)!;
    const up = list.filter((r) => r.outcome === "UP").length;
    // per-bucket test: bucket vs all other buckets pooled
    const rest = rows.filter((r) => closingMinuteBucket(r.endEpoch) !== bucket);
    const restUp = rest.filter((r) => r.outcome === "UP").length;
    const test = list.length > 0 && rest.length > 0 ? twoProportionTest(up, list.length, restUp, rest.length) : { z: 0, p: 1 };
    return { bucket, list, up, pRaw: list.length > 0 ? test.p : null };
  });

  const rawPs = minuteStatsRaw.map((m) => m.pRaw ?? 1);
  const bhPs = benjaminiHochberg(rawPs);

  const toStat = (bucket: string, list: ResolvedMarketRow[], up: number, pRaw: number | null, pBonf: number | null, pBh: number | null): BucketStat => {
    const wilson = wilsonInterval(up, list.length);
    const moves = list.map((r) => r.absMoveBps).filter((x): x is number => x !== null);
    const vols = list.map((r) => r.volumeUsd).filter((x): x is number => x !== null);
    return {
      bucket,
      n: list.length,
      up,
      upRate: list.length > 0 ? up / list.length : 0,
      wilsonLo: wilson.lo,
      wilsonHi: wilson.hi,
      pRaw,
      pBonferroni: pBonf,
      pBh,
      medianAbsMoveBps: moves.length > 0 ? median(moves) : null,
      meanAbsMoveBps: moves.length > 0 ? moves.reduce((s, x) => s + x, 0) / moves.length : null,
      p90AbsMoveBps: moves.length > 0 ? quantile(moves, 0.9) : null,
      medianVolume: vols.length > 0 ? median(vols) : null,
    };
  };

  const buckets: BucketStat[] = minuteStatsRaw.map((m, i) =>
    toStat(m.bucket, m.list, m.up, m.pRaw, m.pRaw === null ? null : bonferroni(m.pRaw, 12), bhPs[i] ?? null),
  );

  const qUp = quarter.filter((r) => r.outcome === "UP").length;
  const oUp = other.filter((r) => r.outcome === "UP").length;
  const qvo = quarter.length > 0 && other.length > 0 ? twoProportionTest(qUp, quarter.length, oUp, other.length) : { z: 0, p: 1 };
  buckets.push(toStat("quarter", quarter, qUp, qvo.p, null, null));
  buckets.push(toStat("other", other, oUp, qvo.p, null, null));
  const allUp = rows.filter((r) => r.outcome === "UP").length;
  buckets.push(toStat("all", rows, allUp, null, null, null));

  const globalChi2 = chiSquareUpDownBuckets(
    CLOSING_MINUTE_BUCKETS.map((b) => {
      const list = byBucket.get(b)!;
      return { up: list.filter((r) => r.outcome === "UP").length, n: list.length };
    }),
  );

  return { windowDays, buckets, globalChi2, quarterVsOther: { z: qvo.z, p: qvo.p } };
}

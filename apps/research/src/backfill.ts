import { researchMarkets, timingBucketStatistics, type DbHandle } from "@b5p/db";
import { newId } from "@b5p/domain/ids";
import { slotStartEpoch } from "@b5p/domain";
import { GammaClient, parseFiveMinMarket, resolvedOutcome } from "@b5p/polymarket";
import { and, gte, lte } from "drizzle-orm";
import { computeTimingStats, type ResolvedMarketRow } from "./timing";

/**
 * Historical ingestion by deterministic slug enumeration (one Gamma request
 * per 5-minute market; resumable, order-independent) plus Binance 5m candles
 * for move magnitudes. Progress reported via callback so the API can stream it.
 */

export interface BackfillProgress {
  scanned: number;
  found: number;
  total: number;
}

export async function backfillResolvedMarkets(
  db: DbHandle,
  opts: {
    fromEpoch: number;
    toEpoch: number;
    slugPrefix?: string;
    concurrency?: number;
    onProgress?: (p: BackfillProgress) => void;
    fetchImpl?: typeof fetch;
  },
): Promise<{ found: number; scanned: number }> {
  const gamma = new GammaClient(opts.fetchImpl ?? fetch);
  const prefix = opts.slugPrefix ?? "btc-updown-5m-";
  const conc = opts.concurrency ?? 8;
  const slots: number[] = [];
  for (let s = slotStartEpoch(opts.fromEpoch); s <= opts.toEpoch; s += 300) slots.push(s);

  let scanned = 0;
  let found = 0;
  const nowMs = Date.now();

  const worker = async (queue: number[]): Promise<void> => {
    for (;;) {
      const slot = queue.pop();
      if (slot === undefined) return;
      try {
        const ev = await gamma.fetchEventBySlug(`${prefix}${slot}`);
        scanned++;
        if (ev) {
          const p = parseFiveMinMarket(ev);
          const outcome = p ? resolvedOutcome(p) : null;
          if (p && outcome) {
            found++;
            await db.db.insert(researchMarkets).values({
              id: p.marketId,
              slug: p.slug,
              startEpoch: p.startEpoch,
              endEpoch: p.endEpoch,
              outcome,
              volumeUsd: p.volumeUsd,
              priceToBeat: null,
              raw: null, // full payloads are large; stats need only the fields above
              ingestedAtMs: nowMs,
            }).onConflictDoNothing();
          }
        }
      } catch {
        scanned++;
      }
      if (scanned % 25 === 0) opts.onProgress?.({ scanned, found, total: slots.length });
    }
  };

  const queue = [...slots];
  await Promise.all(Array.from({ length: conc }, () => worker(queue)));
  opts.onProgress?.({ scanned, found, total: slots.length });
  return { found, scanned };
}

/** Binance 5m candles for |move| bps per slot (diagnostic magnitudes only, never outcomes). */
export async function fetchBinanceMoves(
  fromEpoch: number,
  toEpoch: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  let start = fromEpoch * 1000;
  const endMs = toEpoch * 1000;
  while (start < endMs) {
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=1000&startTime=${start}&endTime=${endMs}`;
    const res = await fetchImpl(url);
    if (!res.ok) break;
    const rows = (await res.json()) as Array<[number, string, string, string, string, string]>;
    if (rows.length === 0) break;
    for (const r of rows) {
      const openTime = Math.floor(r[0] / 1000);
      const open = Number(r[1]);
      const close = Number(r[4]);
      if (open > 0) out.set(openTime, Math.abs((close - open) / open) * 10_000);
    }
    start = rows[rows.length - 1]![0] + 300_000;
  }
  return out;
}

/** Compute a timing-stats run from ingested markets and persist it. */
export async function runTimingStats(
  db: DbHandle,
  opts: {
    windowDaysList?: number[];
    nowEpoch?: number;
    withBinanceMoves?: boolean;
    fetchImpl?: typeof fetch;
    source?: string;
  } = {},
): Promise<{ runId: string; windows: number[] }> {
  const nowEpoch = opts.nowEpoch ?? Math.floor(Date.now() / 1000);
  const windows = opts.windowDaysList ?? [7, 14, 30, 60, 90];
  const runId = newId();
  const nowMs = Date.now();

  for (const windowDays of windows) {
    const fromEpoch = nowEpoch - windowDays * 86400;
    const rows = await db.db.select().from(researchMarkets)
      .where(and(gte(researchMarkets.endEpoch, fromEpoch), lte(researchMarkets.endEpoch, nowEpoch)));
    if (rows.length === 0) continue;

    let moves = new Map<number, number>();
    if (opts.withBinanceMoves !== false) {
      try {
        moves = await fetchBinanceMoves(fromEpoch, nowEpoch, opts.fetchImpl ?? fetch);
      } catch { /* magnitudes stay null */ }
    }

    const data: ResolvedMarketRow[] = rows.map((r) => ({
      endEpoch: r.endEpoch,
      outcome: r.outcome as "UP" | "DOWN",
      volumeUsd: r.volumeUsd,
      absMoveBps: moves.get(r.startEpoch) ?? null,
    }));
    const result = computeTimingStats(data, windowDays);
    for (const b of result.buckets) {
      await db.db.insert(timingBucketStatistics).values({
        id: newId(),
        runId,
        source: opts.source ?? "gamma",
        windowDays,
        bucket: b.bucket,
        n: b.n,
        up: b.up,
        upRate: b.upRate,
        wilsonLo: b.wilsonLo,
        wilsonHi: b.wilsonHi,
        pRaw: b.pRaw,
        pBonferroni: b.pBonferroni,
        pBh: b.pBh,
        medianAbsMoveBps: b.medianAbsMoveBps,
        meanAbsMoveBps: b.meanAbsMoveBps,
        p90AbsMoveBps: b.p90AbsMoveBps,
        medianVolume: b.medianVolume,
        meta: { globalChi2: result.globalChi2, quarterVsOther: result.quarterVsOther },
        computedAtMs: nowMs,
      });
    }
  }
  return { runId, windows };
}

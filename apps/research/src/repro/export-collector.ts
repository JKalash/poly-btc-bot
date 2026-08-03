import { makeDb } from "@b5p/db";
import { sha256OfCanonicalJson, sha256OfFile, type DatasetFileEntry } from "@b5p/evidence";
import { sql } from "drizzle-orm";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Deterministic export of the LOCAL collector DB (embedded PGlite) into CSVs
 * the R1/R2/R7/R8 python scripts consume, plus a DatasetManifest JSON with
 * per-file sha256. The local collector is retired (2026-08-03), so the DB is
 * static and the export is reproducible byte-for-byte; explicit ORDER BY
 * everywhere makes it deterministic even if it were not.
 *
 * SELECT-only: this never migrates or writes the collector DB.
 */

export const COLLECTOR_DATASET_KEY = "collector_local_btc_2026w31";
export const COLLECTOR_MANIFEST_ID = "dm-collector-local-btc-2026w31";

const FEATURE_COLUMNS = [
  "market_id", "ts_ms", "seconds_remaining", "start_epoch", "end_epoch", "outcome",
  "up_mid", "up_best_bid", "up_best_ask", "down_best_bid", "down_best_ask",
  "price_to_beat", "chainlink_now", "binance_now", "chainlink_age_ms", "binance_age_ms",
  "distance_bps", "realized_vol_60s_bps", "data_quality",
  "composite_score", "confidence", "window_delta_pct", "micro_momentum_pct",
  "acceleration_pct", "ema_cross_signal", "rsi", "volume_surge_ratio", "tick_trend",
  "weights_version",
] as const;

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function toCsv(header: readonly string[], rows: unknown[][]): string {
  const lines = [header.join(",")];
  for (const r of rows) lines.push(r.map(csvCell).join(","));
  return lines.join("\n") + "\n";
}

export interface CollectorExportResult {
  ok: boolean;
  reason: string | null;
  dir: string;
  files: DatasetFileEntry[];
  refTickRows: number;
  featureRows: number;
  marketRows: number;
}

export async function exportCollector(root: string, outDir: string): Promise<CollectorExportResult> {
  const pgliteDir = process.env.PGLITE_DIR ?? path.join(root, "data", "pglite");
  const empty: CollectorExportResult = {
    ok: false, reason: null, dir: outDir, files: [], refTickRows: 0, featureRows: 0, marketRows: 0,
  };
  if (!process.env.DATABASE_URL && !existsSync(pgliteDir)) {
    return { ...empty, reason: `collector DB not present (${pgliteDir})` };
  }

  let handle: Awaited<ReturnType<typeof makeDb>>;
  try {
    handle = await makeDb();
  } catch (e) {
    return { ...empty, reason: `collector DB open failed: ${(e as Error).message}` };
  }
  /** Keyset-paginate by numeric id: large single result sets crash PGlite's WASM. */
  async function paged(table: string, cols: string, extra = ""): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    let last = -1;
    for (;;) {
      const r = await handle.db.execute(sql.raw(
        `select id as __id, ${cols} from ${table} where id > ${last} ${extra} order by id limit 5000`,
      ));
      const rows = r.rows as Array<Record<string, unknown>>;
      if (rows.length === 0) break;
      out.push(...rows);
      last = Number(rows[rows.length - 1]!.__id);
    }
    return out;
  }

  try {
    mkdirSync(outDir, { recursive: true });

    const ticks = await paged("reference_price_ticks",
      "source, symbol, value_text, value_float, source_ts_ms, received_ts_ms");
    ticks.sort((a, b) =>
      String(a.source).localeCompare(String(b.source)) ||
      Number(a.source_ts_ms) - Number(b.source_ts_ms) ||
      Number(a.__id) - Number(b.__id));
    const tickRows = ticks.map((r) => [
      r.source, r.symbol, r.value_text, Number(r.value_float), Number(r.source_ts_ms), Number(r.received_ts_ms),
    ]);
    writeFileSync(path.join(outDir, "ref_ticks.csv"),
      toCsv(["source", "symbol", "value_text", "value_float", "source_ts_ms", "received_ts_ms"], tickRows));

    const markets = await handle.db.execute(sql.raw(
      `select id, condition_id, slug, start_epoch, end_epoch, outcome, price_to_beat_text
       from markets where outcome is not null order by start_epoch, id`,
    ));
    const marketRows = (markets.rows as Array<Record<string, unknown>>).map((r) => [
      r.id, r.condition_id, r.slug, Number(r.start_epoch), Number(r.end_epoch), r.outcome, r.price_to_beat_text,
    ]);
    writeFileSync(path.join(outDir, "markets.csv"),
      toCsv(["id", "condition_id", "slug", "start_epoch", "end_epoch", "outcome", "price_to_beat_text"], marketRows));

    const resolvedIds = new Set(marketRows.map((r) => String(r[0])));
    const epochByMarket = new Map(marketRows.map((r) => [String(r[0]), { start: r[3], end: r[4], outcome: r[5] }]));
    const featsRaw = await paged("feature_snapshots", "market_id, ts_ms, features");
    const feats = featsRaw
      .filter((r) => resolvedIds.has(String(r.market_id)))
      .map((r): Record<string, unknown> => {
        const e = epochByMarket.get(String(r.market_id))!;
        return { ...r, start_epoch: e.start, end_epoch: e.end, outcome: e.outcome };
      });
    feats.sort((a, b) =>
      String(a.market_id).localeCompare(String(b.market_id)) ||
      Number(a.ts_ms) - Number(b.ts_ms) ||
      Number(a.__id) - Number(b.__id));
    const featRows = feats.map((r) => {
      const f = (typeof r.features === "string" ? JSON.parse(r.features) : r.features) as Record<string, unknown>;
      const ind = (f.indicators ?? {}) as Record<string, unknown>;
      const vol = (f.realizedVolBps ?? {}) as Record<string, unknown>;
      const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
      return [
        r.market_id, Number(r.ts_ms), num(f.secondsRemaining), Number(r.start_epoch), Number(r.end_epoch), r.outcome,
        num(f.upMid), num(f.upBestBid), num(f.upBestAsk), num(f.downBestBid), num(f.downBestAsk),
        num(f.priceToBeat), num(f.chainlinkNow), num(f.binanceNow), num(f.chainlinkAgeMs), num(f.binanceAgeMs),
        num(f.distanceBps), num(vol["60s"]), num(f.dataQualityScore),
        num(ind.compositeScore), num(ind.confidence), num(ind.windowDeltaPct), num(ind.microMomentumPct),
        num(ind.accelerationPct), num(ind.emaCrossSignal), num(ind.rsi), num(ind.volumeSurgeRatio),
        num(ind.tickTrend), ind.weightsVersion ?? "",
      ];
    });
    writeFileSync(path.join(outDir, "feature_market_snapshots.csv"), toCsv(FEATURE_COLUMNS, featRows));

    const files: DatasetFileEntry[] = [];
    for (const name of ["ref_ticks.csv", "markets.csv", "feature_market_snapshots.csv"]) {
      const p = path.join(outDir, name);
      const { sha256, bytes } = await sha256OfFile(p);
      files.push({ path: path.relative(root, p), sha256, bytes, rows: null });
    }
    const manifest = {
      id: COLLECTOR_MANIFEST_ID,
      datasetKey: COLLECTOR_DATASET_KEY,
      title: "Local collector export: BTC reference ticks + engine feature snapshots (Jul 31 - Aug 3 2026)",
      source: "embedded PGlite collector DB (data/pglite): reference_price_ticks, feature_snapshots, markets; SELECT-only deterministic export",
      license: null,
      files,
      contentChecksum: sha256OfCanonicalJson(files),
      schemaDescription:
        "ref_ticks.csv: chainlink+binance btc/usd ticks with source/receive timestamps. " +
        "feature_market_snapshots.csv: per-second engine feature snapshots joined to resolved markets " +
        "(book tops, chainlink/binance values, gist_composite_v1 sub-indicators). markets.csv: resolved windows.",
      materialized: true,
    };
    writeFileSync(path.join(outDir, "collector_manifest.json"), JSON.stringify(manifest, null, 1));

    return {
      ok: true, reason: null, dir: outDir, files,
      refTickRows: tickRows.length, featureRows: featRows.length, marketRows: marketRows.length,
    };
  } catch (e) {
    return { ...empty, reason: `collector export failed: ${(e as Error).message}` };
  } finally {
    await handle.close();
  }
}

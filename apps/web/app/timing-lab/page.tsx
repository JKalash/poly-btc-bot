"use client";

import { useState } from "react";
import { Card, Empty, Meter, Th, Td } from "../../components/ui";
import { api } from "../../lib/api";
import { fmtTs, useApi } from "../../lib/hooks";

interface StatRow {
  bucket: string; windowDays: number; n: number; up: number; upRate: number;
  wilsonLo: number; wilsonHi: number; pRaw: number | null; pBonferroni: number | null; pBh: number | null;
  medianAbsMoveBps: number | null; meanAbsMoveBps: number | null; p90AbsMoveBps: number | null; medianVolume: number | null;
  meta: { note?: string; globalChi2?: { chi2: number; df: number; p: number }; quarterVsOther?: { z: number; p: number } } | null;
}
interface Payload {
  runId: string; source: string; computedAtMs: number; researchMarketCount: number; rows: StatRow[]; warning: string;
}
interface RefreshStatus { running: boolean; progress: { scanned: number; found: number; total: number } | null; error: string | null }

const pFmt = (p: number | null): string => (p === null ? "—" : p < 0.0001 ? p.toExponential(1) : p.toFixed(4));

export default function TimingLabPage() {
  const { data, reload } = useApi<Payload>("/api/timing-lab", 0);
  const status = useApi<RefreshStatus>("/api/timing-lab/refresh/status", 3000);
  const [windowDays, setWindowDays] = useState(30);
  const [hours, setHours] = useState(24);
  const [starting, setStarting] = useState(false);

  const rows = (data?.rows ?? []).filter((r) => r.windowDays === windowDays);
  const minuteRows = rows.filter((r) => /^\d\d$/.test(r.bucket)).sort((a, b) => a.bucket.localeCompare(b.bucket));
  const quarterRow = rows.find((r) => r.bucket === "quarter");
  const otherRow = rows.find((r) => r.bucket === "other");
  const allRow = rows.find((r) => r.bucket === "all");
  const meta = rows.find((r) => r.meta?.globalChi2)?.meta ?? null;
  const windows = [...new Set((data?.rows ?? []).map((r) => r.windowDays))].sort((a, b) => a - b);

  const refresh = async () => {
    setStarting(true);
    try {
      await api("/api/timing-lab/refresh", { method: "POST", body: JSON.stringify({ hours }) });
      status.reload();
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="border border-warning/40 bg-warning/10 rounded-lg px-4 py-3 text-warning text-[13px] font-semibold">
        ⚠ {data?.warning ?? "Outcome skew is not trading edge unless price fails to reflect it."}
      </div>

      <Card
        title={`Timing Lab · run ${data?.runId?.slice(0, 8) ?? "—"} · source: ${data?.source ?? "—"} · computed ${fmtTs(data?.computedAtMs)}`}
        right={
          <div className="flex items-center gap-3 text-[12px]">
            <div className="flex gap-1" role="tablist" aria-label="window">
              {windows.map((w) => (
                <button key={w} onClick={() => setWindowDays(w)}
                  className={`px-2 py-1 rounded ${w === windowDays ? "bg-panel2 text-ink font-semibold" : "text-muted hover:text-ink"}`}>
                  {w}d
                </button>
              ))}
            </div>
            <span className="text-muted">refresh last</span>
            <select value={hours} onChange={(e) => setHours(Number(e.target.value))} className="bg-page border border-hairline rounded px-1.5 py-1">
              {[6, 12, 24, 48, 72].map((h) => <option key={h} value={h}>{h}h</option>)}
            </select>
            <button onClick={() => void refresh()} disabled={starting || status.data?.running}
              className="border border-up/50 text-up rounded px-2.5 py-1 hover:bg-up/10 disabled:opacity-50">
              {status.data?.running ? "refreshing…" : "Refresh from Gamma"}
            </button>
            <button onClick={reload} className="text-muted hover:text-ink">↻ reload</button>
          </div>
        }
      >
        {status.data?.running && status.data.progress && (
          <div className="text-[12px] text-muted mb-3">
            backfill: scanned {status.data.progress.scanned}/{status.data.progress.total}, resolved found {status.data.progress.found}
          </div>
        )}
        {status.data?.error && <div className="text-critical text-[12px] mb-3">refresh failed: {status.data.error}</div>}

        {rows.length === 0 ? (
          <Empty text={`No rows for the ${windowDays}d window in this run. The seeded run covers 30d (full) and 7d (partial). Refresh from Gamma to compute live windows.`} />
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <Th>Closing minute (UTC)</Th><Th>N</Th><Th>Up rate</Th><Th>Wilson 95%</Th>
                <Th>Up-rate meter</Th><Th>p raw</Th><Th>p Bonferroni</Th><Th>p BH</Th>
                <Th>|move| median bps</Th><Th>p90 bps</Th><Th>median volume</Th>
              </tr>
            </thead>
            <tbody>
              {minuteRows.map((r) => (
                <tr key={r.bucket} className={r.meta?.note?.includes("UNCONFIRMED") ? "bg-warning/5" : ""}>
                  <Td className="num">:{r.bucket}{r.bucket === "45" && <span className="text-warning ml-2 text-[10px]">unconfirmed / selection-sensitive</span>}</Td>
                  <Td className="num">{r.n}</Td>
                  <Td className="num text-ink font-semibold">{(r.upRate * 100).toFixed(2)}%</Td>
                  <Td className="num text-muted">{(r.wilsonLo * 100).toFixed(1)}–{(r.wilsonHi * 100).toFixed(1)}%</Td>
                  <Td><Meter value={r.upRate} max={0.65} className="w-28" /></Td>
                  <Td className="num">{pFmt(r.pRaw)}</Td>
                  <Td className={`num ${r.pBonferroni !== null && r.pBonferroni < 0.05 ? "text-warning font-semibold" : ""}`}>{pFmt(r.pBonferroni)}</Td>
                  <Td className="num">{pFmt(r.pBh)}</Td>
                  <Td className="num">{r.medianAbsMoveBps?.toFixed(2) ?? "—"}</Td>
                  <Td className="num">{r.p90AbsMoveBps?.toFixed(2) ?? "—"}</Td>
                  <Td className="num">{r.medianVolume ? (r.medianVolume / 1000).toFixed(1) + "k" : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div className="grid grid-cols-3 gap-4">
        <Card title="Quarter-hour vs other closes">
          {!quarterRow || !otherRow ? <Empty text="—" /> : (
            <dl className="text-[13px] space-y-2">
              <div className="flex justify-between"><dt className="text-muted">Quarter (:00/:15/:30/:45)</dt>
                <dd className="num text-ink">{(quarterRow.upRate * 100).toFixed(2)}% up · N={quarterRow.n}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Other minutes</dt>
                <dd className="num text-ink">{(otherRow.upRate * 100).toFixed(2)}% up · N={otherRow.n}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Direction test</dt>
                <dd className="num text-ink">z={meta?.quarterVsOther?.z.toFixed(2) ?? "—"} p={pFmt(meta?.quarterVsOther?.p ?? null)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">|move| median (q vs other)</dt>
                <dd className="num text-ink">{quarterRow.medianAbsMoveBps?.toFixed(2) ?? "—"} vs {otherRow.medianAbsMoveBps?.toFixed(2) ?? "—"} bps</dd></div>
              <p className="text-muted text-[11px] pt-2">The robust finding is calmness at quarter closes, not direction. Calmness is not profit: the market can price it.</p>
            </dl>
          )}
        </Card>
        <Card title="Global minute-of-hour test">
          <dl className="text-[13px] space-y-2">
            <div className="flex justify-between"><dt className="text-muted">All windows up rate</dt>
              <dd className="num text-ink">{allRow ? (allRow.upRate * 100).toFixed(2) + "%" : "—"} · N={allRow?.n ?? "—"}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Chi-square (12 buckets)</dt>
              <dd className="num text-ink">{meta?.globalChi2 ? `χ²=${meta.globalChi2.chi2.toFixed(2)}, df=${meta.globalChi2.df}, p=${pFmt(meta.globalChi2.p)}` : "—"}</dd></div>
            <p className="text-muted text-[11px] pt-2">No reliable overall directional effect. Minute-of-hour patterns must be tested out of sample and corrected for multiple comparisons; they are never standalone signals.</p>
          </dl>
        </Card>
        <Card title="Data lineage">
          <ul className="text-[12px] space-y-1.5 text-ink2">
            <li>Outcomes: official Gamma resolved markets ({data?.researchMarketCount ?? 0} ingested locally).</li>
            <li>Move magnitudes: Binance 5m candles — diagnostic only, never the settlement source.</li>
            <li>Settlement source: Chainlink BTC/USD data stream (per market rules).</li>
            <li>Corrections: Bonferroni and Benjamini-Hochberg across the 12 inspected buckets.</li>
            <li>All computations UTC; display timezone is presentation only.</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}

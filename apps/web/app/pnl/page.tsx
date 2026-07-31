"use client";

import { Card, Empty, Th, Td } from "../../components/ui";
import { useApi } from "../../lib/hooks";

interface Summary {
  byMode: Record<string, { gross: string; fees: string; net: string; n: number; wins: number }>;
  byClosingMinute: Record<string, { net: string; n: number; wins: number }>;
  maxDrawdown6: string;
  longestLossStreak: number;
  openPositions: number;
  totalRecords: number;
}

const fmt = (v: string) => {
  const n = Number(v) / 1e6;
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}`;
};

export default function PnlPage() {
  const { data } = useApi<Summary>("/api/pnl/summary", 10_000);
  if (!data) return <Empty text="Loading P&L…" />;
  const modes = Object.entries(data.byMode);
  const buckets = Object.entries(data.byClosingMinute).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="grid grid-cols-2 gap-4">
      <Card title="Net P&L by mode (paper results never mix with live)">
        {modes.length === 0 ? <Empty text="No resolved trades yet" /> : (
          <table className="w-full">
            <thead><tr><Th>Mode</Th><Th>Trades</Th><Th>Win rate</Th><Th>Gross</Th><Th>Fees</Th><Th>Net</Th></tr></thead>
            <tbody>
              {modes.map(([mode, m]) => (
                <tr key={mode}>
                  <Td className="font-semibold text-ink">{mode}</Td>
                  <Td className="num">{m.n}</Td>
                  <Td className="num">{m.n > 0 ? ((m.wins / m.n) * 100).toFixed(1) + "%" : "—"}</Td>
                  <Td className="num">{fmt(m.gross)}</Td>
                  <Td className="num text-muted">-{(Number(m.fees) / 1e6).toFixed(2)}</Td>
                  <Td className={`num font-semibold ${Number(m.net) > 0 ? "text-good" : Number(m.net) < 0 ? "text-critical" : ""}`}>{fmt(m.net)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="grid grid-cols-3 gap-4 mt-4 pt-4 border-t border-hairline text-[13px]">
          <div><span className="text-muted block text-[11px] uppercase tracking-wider">Max drawdown</span>
            <span className="num text-critical font-semibold">{(Number(data.maxDrawdown6) / 1e6).toFixed(2)}</span></div>
          <div><span className="text-muted block text-[11px] uppercase tracking-wider">Longest loss streak</span>
            <span className="num text-ink font-semibold">{data.longestLossStreak}</span></div>
          <div><span className="text-muted block text-[11px] uppercase tracking-wider">Resolved trades</span>
            <span className="num text-ink font-semibold">{data.totalRecords}</span></div>
        </div>
      </Card>

      <Card title="Net P&L by closing minute (fill-conditioned; small N means nothing)">
        {buckets.length === 0 ? <Empty text="No resolved trades yet" /> : (
          <table className="w-full">
            <thead><tr><Th>Closing minute</Th><Th>Trades</Th><Th>Win rate</Th><Th>Net</Th></tr></thead>
            <tbody>
              {buckets.map(([bucket, b]) => (
                <tr key={bucket}>
                  <Td className="num">:{bucket}</Td>
                  <Td className="num">{b.n}</Td>
                  <Td className="num">{b.n > 0 ? ((b.wins / b.n) * 100).toFixed(0) + "%" : "—"}</Td>
                  <Td className={`num ${Number(b.net) > 0 ? "text-good" : Number(b.net) < 0 ? "text-critical" : ""}`}>{fmt(b.net)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-[11px] text-muted mt-3">Minute-of-hour buckets are diagnostics, never standalone signals. Expected-vs-realized attribution requires more filled samples than a young paper session provides.</p>
      </Card>
    </div>
  );
}

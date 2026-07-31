"use client";

import { useState } from "react";
import { Card, Empty, Th, Td } from "../../components/ui";
import { api } from "../../lib/api";
import { fmtTs, useApi } from "../../lib/hooks";
import { useCockpitCtx } from "../../components/Shell";

interface AuditRow { id: string; category: string; action: string; actor: string; data: Record<string, unknown> | null; createdAtMs: number }
interface HealthRow { id: string; kind: string; severity: string; message: string; createdAtMs: number }

const sevCls: Record<string, string> = { info: "text-ink2", warning: "text-warning", critical: "text-critical" };

export default function AuditPage() {
  const audit = useApi<AuditRow[]>("/api/audit?limit=200", 5000);
  const health = useApi<HealthRow[]>("/api/health/events?limit=100", 5000);
  const { state: s } = useCockpitCtx();
  const [resuming, setResuming] = useState(false);

  const resume = async () => {
    setResuming(true);
    try { await api("/api/resume", { method: "POST", body: JSON.stringify({}) }); } finally { setResuming(false); }
  };

  return (
    <div className="grid grid-cols-2 gap-4">
      <Card
        title="Health events"
        right={s?.engineState === "HALTED" ? (
          <button onClick={() => void resume()} disabled={resuming}
            className="border border-warning/60 text-warning rounded px-3 py-1 text-[12px] font-semibold hover:bg-warning/10">
            {resuming ? "…" : "Manual review done — re-arm engine"}
          </button>
        ) : undefined}
      >
        {!health.data || health.data.length === 0 ? <Empty text="No health events" /> : (
          <table className="w-full">
            <thead><tr><Th>Time</Th><Th>Severity</Th><Th>Kind</Th><Th>Message</Th></tr></thead>
            <tbody>
              {health.data.map((h) => (
                <tr key={h.id}>
                  <Td className="num">{fmtTs(h.createdAtMs)}</Td>
                  <Td><span className={`font-semibold ${sevCls[h.severity] ?? ""}`}>{h.severity === "critical" ? "⚠ " : ""}{h.severity}</span></Td>
                  <Td>{h.kind}</Td>
                  <Td className="text-ink2">{h.message}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Audit log (append-only)">
        {!audit.data || audit.data.length === 0 ? <Empty text="No audit events" /> : (
          <table className="w-full">
            <thead><tr><Th>Time</Th><Th>Category</Th><Th>Action</Th><Th>Actor</Th><Th>Data</Th></tr></thead>
            <tbody>
              {audit.data.map((a) => (
                <tr key={a.id}>
                  <Td className="num">{fmtTs(a.createdAtMs)}</Td>
                  <Td>{a.category}</Td>
                  <Td className="text-ink">{a.action}</Td>
                  <Td className="text-muted">{a.actor}</Td>
                  <Td className="font-mono text-[10px] text-muted truncate max-w-[16rem]" >
                    {a.data ? JSON.stringify(a.data).slice(0, 120) : "—"}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

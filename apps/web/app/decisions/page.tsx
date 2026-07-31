"use client";

import Link from "next/link";
import { Card, Check, Empty, Th, Td } from "../../components/ui";
import { fmtTs, useApi } from "../../lib/hooks";

interface Row {
  decisionId: string;
  marketId: string;
  mode: string;
  createdAtMs: number;
  approved: boolean | null;
  reasons: Array<{ code: string }>;
}

export default function DecisionsPage() {
  const { data } = useApi<Row[]>("/api/decisions?limit=100", 5000);
  return (
    <Card title="Decisions — every one reconstructable from its immutable snapshot">
      {!data || data.length === 0 ? (
        <Empty text="No decisions yet. The engine records one for every risk-evaluated candidate, approved or rejected." />
      ) : (
        <table className="w-full">
          <thead><tr><Th>Time (UTC)</Th><Th>Mode</Th><Th>Approved</Th><Th>Rejection codes</Th><Th>Snapshot</Th></tr></thead>
          <tbody>
            {data.map((r) => (
              <tr key={r.decisionId} className="hover:bg-panel2">
                <Td className="num">{fmtTs(r.createdAtMs)}</Td>
                <Td>{r.mode}</Td>
                <Td>{r.approved === null ? <span className="text-muted">—</span> : <Check pass={r.approved} />}</Td>
                <Td className="font-mono text-[11px] text-muted">{r.reasons.map((x) => x.code).join(", ") || "—"}</Td>
                <Td><Link className="text-up hover:underline" href={`/decisions/${r.decisionId}`}>inspect</Link></Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

"use client";

import { use } from "react";
import { Card, Check, Empty } from "../../../components/ui";
import { fmtTs, useApi } from "../../../lib/hooks";

interface Detail {
  snapshot: { decisionId: string; marketId: string; mode: string; createdAtMs: number; data: Record<string, unknown> };
  risk: { approved: boolean; reasons: Array<{ code: string; message: string }>; capChain: Array<{ name: string; capPpm: string }> } | null;
  orders: Array<{ id: string; status: string; statusReason: string | null; price6: string; shares6: string; filledShares6: string; style: string; postOnly: boolean }>;
  fills: Array<{ id: string; price6: string; shares6: string; feeUsdc6: string; maker: boolean; tsMs: number }>;
}

export default function DecisionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data } = useApi<Detail>(`/api/decisions/${id}`);
  if (!data) return <Empty text="Loading decision…" />;
  const d = data.snapshot.data as Record<string, never> & {
    intent?: { side: string; style: string; price: string; sharesRequested: string; stake: string; maxLoss: string };
    model?: { version: string; probability: string; conservative: string; uncertainty: number };
    effectiveBreakEven?: string;
    marketProbability?: string;
    evPerCostRaw?: number;
    risk?: { profile: string; bankroll: string; stakeFraction: string; bindingCap: string | null; limits: Record<string, string> };
    priceToBeat?: { value: string; source: string };
    distance?: { usd: number; bps: number; z: number | null };
    targetReturnDisplay?: { requiredStakeFraction: string; violatesCap: boolean };
    narrative?: string[];
    title?: string;
    tutorial?: boolean;
  };

  return (
    <div className="grid grid-cols-2 gap-4">
      <Card title={`Decision ${id.slice(0, 8)} · ${data.snapshot.mode} · ${fmtTs(data.snapshot.createdAtMs)}`}>
        {d.tutorial && (
          <div className="border border-warning/40 bg-warning/10 rounded p-3 mb-4">
            <div className="text-warning font-semibold text-[13px] mb-1">{d.title}</div>
            {d.narrative?.map((line, i) => <p key={i} className="text-[12px] text-ink2 mb-1">{line}</p>)}
          </div>
        )}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
          {d.intent && (<>
            <dt className="text-muted">Intent</dt>
            <dd className="text-ink">{d.intent.side} · {d.intent.style} · {d.intent.price}</dd>
            <dt className="text-muted">Shares / stake / max loss</dt>
            <dd className="num text-ink">{d.intent.sharesRequested} / ${d.intent.stake} / <span className="text-warning">${d.intent.maxLoss}</span></dd>
          </>)}
          {d.model && (<>
            <dt className="text-muted">Model</dt>
            <dd className="text-ink">{d.model.version}{d.model.version.includes("UNCALIBRATED") && <span className="text-warning ml-1">(uncalibrated)</span>}</dd>
            <dt className="text-muted">P (model / conservative)</dt>
            <dd className="num text-ink">{d.model.probability} / {d.model.conservative} <span className="text-muted">±{d.model.uncertainty.toFixed(3)}</span></dd>
          </>)}
          <dt className="text-muted">Market probability</dt>
          <dd className="num text-ink">{d.marketProbability ?? "—"}</dd>
          <dt className="text-muted">Effective break-even</dt>
          <dd className="num text-ink">{d.effectiveBreakEven ?? "—"}</dd>
          <dt className="text-muted">EV per cost</dt>
          <dd className="num text-ink">{d.evPerCostRaw === undefined || d.evPerCostRaw === null ? "—" : (d.evPerCostRaw * 100).toFixed(2) + "%"}</dd>
          {d.priceToBeat && (<>
            <dt className="text-muted">Price to beat</dt>
            <dd className="num text-ink">{d.priceToBeat.value} <span className="text-muted">({d.priceToBeat.source})</span></dd>
          </>)}
          {d.distance && (<>
            <dt className="text-muted">Distance</dt>
            <dd className="num text-ink">{d.distance.usd.toFixed(2)}$ · {d.distance.bps.toFixed(2)}bps · z={d.distance.z?.toFixed(2) ?? "—"}</dd>
          </>)}
          {d.targetReturnDisplay && (<>
            <dt className="text-muted">1% target would require</dt>
            <dd className="num text-ink">
              {(Number(d.targetReturnDisplay.requiredStakeFraction) * 100).toFixed(2)}% of bankroll
              {d.targetReturnDisplay.violatesCap && <span className="text-critical ml-1 font-semibold">— exceeds your configured cap; targets never authorize risk</span>}
            </dd>
          </>)}
        </dl>
      </Card>

      <div className="space-y-4">
        <Card title="Risk verdict">
          {!data.risk ? <Empty text="No risk decision recorded" /> : (
            <div>
              <div className={`font-bold text-[15px] mb-3 ${data.risk.approved ? "text-good" : "text-critical"}`}>
                {data.risk.approved ? "APPROVED" : "REJECTED — order rejected safely"}
              </div>
              {data.risk.reasons.map((r) => (
                <div key={r.code} className="text-[12px] mb-1.5"><span className="font-mono text-warning">{r.code}</span> <span className="text-ink2">{r.message}</span></div>
              ))}
              {d.risk && (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] mt-3 border-t border-hairline pt-3">
                  <dt className="text-muted">Profile</dt><dd className="text-ink">{d.risk.profile}</dd>
                  <dt className="text-muted">Bankroll</dt><dd className="num text-ink">${d.risk.bankroll}</dd>
                  <dt className="text-muted">Stake fraction</dt><dd className="num text-ink">{(Number(d.risk.stakeFraction) * 100).toFixed(2)}%</dd>
                  <dt className="text-muted">Binding cap</dt><dd className="text-ink">{d.risk.bindingCap ?? "—"}</dd>
                </dl>
              )}
            </div>
          )}
        </Card>

        <Card title="Orders & fills">
          {data.orders.length === 0 ? <Empty text="No orders (decision rejected or shadow)" /> : (
            <div className="space-y-3">
              {data.orders.map((o) => (
                <div key={o.id} className="text-[12px]">
                  <div className="flex items-center gap-2">
                    <Check pass={o.status === "MATCHED"} />
                    <span className="text-ink font-semibold">{o.style}</span>
                    {o.postOnly && <span className="text-up text-[11px] border border-up/40 rounded px-1">post-only</span>}
                    <span className="num text-ink">{(Number(o.price6) / 1e6).toFixed(2)}</span>
                    <span className="num text-muted">{(Number(o.filledShares6) / 1e6).toFixed(1)}/{(Number(o.shares6) / 1e6).toFixed(1)} sh</span>
                    <span className="text-muted">{o.status}</span>
                  </div>
                  {o.statusReason && <div className="text-muted ml-6">{o.statusReason}</div>}
                </div>
              ))}
              {data.fills.map((f) => (
                <div key={f.id} className="text-[12px] ml-6 num text-ink2">
                  fill {(Number(f.shares6) / 1e6).toFixed(2)} sh @ {(Number(f.price6) / 1e6).toFixed(2)}
                  {" · fee "}{(Number(f.feeUsdc6) / 1e6).toFixed(4)} USDC · {f.maker ? "maker (fee 0)" : "taker"} · {fmtTs(f.tsMs)}
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Raw snapshot (audit)">
          <pre className="text-[10px] text-muted overflow-auto max-h-96 whitespace-pre-wrap">{JSON.stringify(d, null, 2)}</pre>
        </Card>
      </div>
    </div>
  );
}

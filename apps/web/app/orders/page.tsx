"use client";

import Link from "next/link";
import { useState } from "react";
import { Card, Empty, SideTag, Th, Td } from "../../components/ui";
import { fmtTs, u6, useApi } from "../../lib/hooks";

interface OrderRow {
  id: string; decisionId: string; marketId: string; outcomeSide: string; style: string;
  postOnly: boolean; price6: string; shares6: string; filledShares6: string; stake6: string;
  mode: string; status: string; statusReason: string | null; createdAtMs: number;
}
interface PositionRow {
  id: string; marketId: string; decisionId: string | null; mode: string; outcomeSide: string;
  shares6: string; avgPrice6: string; cost6: string; stake6: string; status: string;
  outcome: string | null; pnl6: string | null; openedAtMs: number; exitPolicy: string;
}

export default function OrdersPage() {
  const [tab, setTab] = useState<"orders" | "positions">("orders");
  const orders = useApi<OrderRow[]>("/api/orders?limit=200", 5000);
  const positions = useApi<PositionRow[]>("/api/positions?limit=200", 5000);

  return (
    <Card
      title="Orders & positions"
      right={
        <div className="flex gap-1 text-[12px]">
          {(["orders", "positions"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-3 py-1 rounded ${tab === t ? "bg-panel2 text-ink" : "text-muted hover:text-ink"}`}>
              {t}
            </button>
          ))}
        </div>
      }
    >
      {tab === "orders" ? (
        !orders.data || orders.data.length === 0 ? <Empty text="No orders yet" /> : (
          <table className="w-full">
            <thead><tr><Th>Time</Th><Th>Mode</Th><Th>Side</Th><Th>Style</Th><Th>Price</Th><Th>Filled</Th><Th>Max loss</Th><Th>Status</Th><Th>Decision</Th></tr></thead>
            <tbody>
              {orders.data.map((o) => (
                <tr key={o.id} className="hover:bg-panel2">
                  <Td className="num">{fmtTs(o.createdAtMs)}</Td>
                  <Td>{o.mode}</Td>
                  <Td><SideTag side={o.outcomeSide} /></Td>
                  <Td>{o.style}{o.postOnly && <span className="text-up text-[10px] ml-1">[post-only]</span>}</Td>
                  <Td className="num">{u6(o.price6, 2)}</Td>
                  <Td className="num">{u6(o.filledShares6, 1)}/{u6(o.shares6, 1)}</Td>
                  <Td className="num text-warning">${u6(o.stake6)}</Td>
                  <Td><span title={o.statusReason ?? ""}>{o.status}</span></Td>
                  <Td><Link href={`/decisions/${o.decisionId}`} className="text-up hover:underline">snapshot</Link></Td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : (
        !positions.data || positions.data.length === 0 ? <Empty text="No positions yet" /> : (
          <table className="w-full">
            <thead><tr><Th>Opened</Th><Th>Mode</Th><Th>Side</Th><Th>Shares</Th><Th>Avg price</Th><Th>Cost</Th><Th>Exit policy</Th><Th>Status</Th><Th>Outcome</Th><Th>Net P&L</Th></tr></thead>
            <tbody>
              {positions.data.map((p) => {
                const pnl = p.pnl6 === null ? null : Number(p.pnl6);
                return (
                  <tr key={p.id} className="hover:bg-panel2">
                    <Td className="num">{fmtTs(p.openedAtMs)}</Td>
                    <Td>{p.mode}</Td>
                    <Td><SideTag side={p.outcomeSide} /></Td>
                    <Td className="num">{u6(p.shares6, 2)}</Td>
                    <Td className="num">{u6(p.avgPrice6, 3)}</Td>
                    <Td className="num">${u6(p.cost6)}</Td>
                    <Td className="text-muted">{p.exitPolicy}</Td>
                    <Td>{p.status}</Td>
                    <Td>{p.outcome ? <SideTag side={p.outcome} /> : "—"}</Td>
                    <Td className={`num font-semibold ${pnl === null ? "" : pnl > 0 ? "text-good" : pnl < 0 ? "text-critical" : ""}`}>
                      {pnl === null ? "—" : `${pnl > 0 ? "+" : ""}${(pnl / 1e6).toFixed(2)}`}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )
      )}
    </Card>
  );
}

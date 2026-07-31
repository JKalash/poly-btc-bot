"use client";

import { useCockpitCtx } from "../components/Shell";
import { Card, Check, Empty, SideTag, Stat } from "../components/ui";
import { u6 } from "../lib/hooks";

export default function CockpitPage() {
  const { state: s, live } = useCockpitCtx();
  const m = s?.activeMarket ?? null;
  const ind = (m?.indicators ?? null) as Record<string, number | string | null> | null;

  return (
    <div className="grid grid-cols-12 gap-4">
      <Card title={`Current market ${live ? "· live" : "· polling"}`} className="col-span-8">
        {!m ? (
          <Empty text="No active market window. Discovery runs every 20 seconds." />
        ) : (
          <div>
            <div className="flex items-baseline justify-between mb-4">
              <div>
                <span className="text-ink font-semibold text-[15px]">{m.slug}</span>
                <span className="ml-3 text-[12px] text-muted">state {m.state}</span>
                {!m.rulesVerified && <span className="ml-3 text-critical text-[12px] font-semibold">⚠ rules do not name Chainlink — entries blocked</span>}
                {!m.ptbConsistent && <span className="ml-3 text-critical text-[12px] font-semibold">⚠ price-to-beat inconsistent</span>}
              </div>
              <div className="text-[12px] text-muted">next: {s?.nextMarket?.slug ?? "—"}</div>
            </div>

            <div className="grid grid-cols-3 gap-4 mb-4">
              <div className="panel bg-panel2 p-4">
                <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Chainlink BTC/USD (authoritative)</div>
                <div className="num text-3xl font-bold text-ink">
                  {s?.chainlinkNow ? s.chainlinkNow.value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"}
                </div>
                <div className="text-[11px] text-muted mt-1">age {s?.chainlinkNow?.ageMs ?? "?"}ms</div>
              </div>
              <div className="panel bg-panel2 p-4">
                <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Price to beat</div>
                <div className="num text-3xl font-bold text-ink">
                  {m.priceToBeat ? Number(m.priceToBeat).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "not captured"}
                </div>
                {!m.priceToBeat && <div className="text-[11px] text-warning mt-1">The Chainlink boundary value was not captured; decisions cannot be audited.</div>}
              </div>
              <div className="panel bg-panel2 p-4">
                <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Signed distance</div>
                <div className={`num text-3xl font-bold ${m.distanceUsd === null ? "text-muted" : m.distanceUsd >= 0 ? "text-up" : "text-down"}`}>
                  {m.distanceUsd === null ? "—" : `${m.distanceUsd >= 0 ? "+" : ""}${m.distanceUsd.toFixed(2)}`}
                </div>
                <div className="text-[11px] text-muted mt-1">
                  {m.distanceBps === null ? "" : `${m.distanceBps.toFixed(2)} bps`}
                  {m.distanceZ !== null && ` · z=${m.distanceZ.toFixed(2)}`}
                  {m.distanceUsd !== null && ` · ${m.distanceUsd >= 0 ? "UP" : "DOWN"} (tie ⇒ UP)`}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-4 gap-4 mb-4">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted mb-1">UP book</div>
                <div className="num text-[15px]"><span className="text-ink">{m.upBestBid?.toFixed(2) ?? "—"}</span><span className="text-muted"> / </span><span className="text-ink">{m.upBestAsk?.toFixed(2) ?? "—"}</span></div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted mb-1">DOWN book</div>
                <div className="num text-[15px]"><span className="text-ink">{m.downBestBid?.toFixed(2) ?? "—"}</span><span className="text-muted"> / </span><span className="text-ink">{m.downBestAsk?.toFixed(2) ?? "—"}</span></div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Spread / vol</div>
                <div className="num text-[15px] text-ink">{m.spread?.toFixed(3) ?? "—"} <span className="text-muted">/</span> {m.volatilityEwma ? `${m.volatilityEwma.toFixed(2)}bps/√s` : "—"}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Data quality</div>
                <div className={`num text-[15px] font-semibold ${m.dataQuality !== null && m.dataQuality < 0.7 ? "text-warning" : "text-ink"}`}>
                  {m.dataQuality === null ? "—" : (m.dataQuality * 100).toFixed(0) + "%"}
                </div>
              </div>
            </div>

            {ind && (
              <div className="mb-4">
                <div className="text-[11px] uppercase tracking-wider text-muted mb-2">Composite indicators (Binance; confirmation only, never override Chainlink)</div>
                <div className="grid grid-cols-8 gap-2 text-[12px] num">
                  <IndCell label="score" v={ind.compositeScore} dp={3} />
                  <IndCell label="confidence" v={ind.confidence} dp={3} />
                  <IndCell label="Δwindow%" v={ind.windowDeltaPct} dp={4} />
                  <IndCell label="mom30s%" v={ind.microMomentumPct} dp={4} />
                  <IndCell label="accel" v={ind.accelerationPct} dp={4} />
                  <IndCell label="EMA×" v={ind.emaCrossSignal} dp={3} />
                  <IndCell label="RSI" v={ind.rsi} dp={1} />
                  <IndCell label="vol surge" v={ind.volumeSurgeRatio} dp={2} />
                </div>
              </div>
            )}

            <div>
              <div className="flex items-center gap-3 mb-2">
                <span className="text-[11px] uppercase tracking-wider text-muted">Strategy gates · {s?.strategyVersion}</span>
                {m.gate && (
                  <span className={`text-[12px] font-semibold ${m.gate.candidate ? "text-up" : "text-muted"}`}>
                    {m.gate.candidate ? <>CANDIDATE <SideTag side={m.gate.side} /></> : "No verified edge — no trade"}
                  </span>
                )}
              </div>
              <table className="w-full">
                <tbody>
                  {(m.gate?.checks ?? []).map((c) => (
                    <tr key={c.name}>
                      <td className="td w-6"><Check pass={c.pass} /></td>
                      <td className="td text-ink2">{c.name}</td>
                      <td className="td num text-ink">{c.value}</td>
                      <td className="td text-muted">{c.requirement}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {m.lastRejectionReasons.length > 0 && (
                <div className="mt-3 border border-warning/40 bg-warning/10 rounded p-3">
                  <div className="text-[11px] uppercase tracking-wider text-warning mb-1.5 font-semibold">Last risk rejection — what would have to change</div>
                  {m.lastRejectionReasons.map((r) => (
                    <div key={r.code} className="text-[12px] mb-0.5"><span className="text-warning font-mono">{r.code}</span> <span className="text-ink2">{r.message}</span></div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Card>

      <div className="col-span-4 space-y-4">
        <Card title="Session">
          <div className="grid grid-cols-2 divide-x divide-hairline -m-4">
            <Stat label="Bankroll" value={`$${u6(s?.bankroll.bankroll6)}`} sub={s?.bankroll.reconciled ? "reconciled" : "UNRECONCILED"} />
            <Stat label="Consecutive losses" value={s?.bankroll.consecutiveLosses ?? "—"}
              tone={s && s.bankroll.consecutiveLosses > 0 ? "warning" : undefined} />
          </div>
          <div className="border-t border-hairline grid grid-cols-2 divide-x divide-hairline -mx-4 -mb-4 mt-0">
            <Stat label="Open positions" value={s?.bankroll.openPositions ?? "—"} />
            <Stat label="Max possible loss" value={`$${u6(s?.bankroll.openExposure6)}`} />
          </div>
        </Card>

        <Card title="Resting orders">
          {(s?.restingOrders?.length ?? 0) === 0 ? <Empty text="None" /> : (
            <table className="w-full">
              <tbody>
                {s!.restingOrders.map((o) => (
                  <tr key={o.id}>
                    <td className="td"><SideTag side={o.side} /></td>
                    <td className="td num">{u6(o.price6, 2)}</td>
                    <td className="td num">{u6(o.filled6, 1)}/{u6(o.shares6, 1)}</td>
                    <td className="td text-muted">{o.status}</td>
                    <td className="td num text-muted" title="displayed queue ahead">q:{u6(o.queueAhead6, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Open positions">
          {(s?.openPositions?.length ?? 0) === 0 ? <Empty text="None — default strategy assumes stake can go to zero; exits are policy, not improvisation" /> : (
            <table className="w-full">
              <tbody>
                {s!.openPositions.map((p) => (
                  <tr key={p.id}>
                    <td className="td"><SideTag side={p.side} /></td>
                    <td className="td num">{u6(p.shares6, 1)} sh</td>
                    <td className="td num">cost ${u6(p.cost6)}</td>
                    <td className="td num text-warning">risk ${u6(p.stake6)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Mode & governance">
          <ul className="text-[12px] space-y-1.5">
            <li><span className="text-muted">Profile:</span> <span className="text-ink font-semibold">{s?.profile ?? "—"}</span></li>
            <li><span className="text-muted">Strategy:</span> <span className="text-ink">{s?.strategyVersion ?? "—"}</span></li>
            <li><span className="text-muted">Paper sizing sim:</span> <span className="text-ink">{s?.sizingSimulation ?? "—"}</span></li>
            <li className="text-muted pt-1">Live trading is disarmed. No signing path exists in this release.</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}

function IndCell({ label, v, dp }: { label: string; v: number | string | null | undefined; dp: number }) {
  const n = typeof v === "number" ? v : null;
  return (
    <div className="panel bg-panel2 px-2 py-1.5">
      <div className="text-[10px] text-muted">{label}</div>
      <div className="text-ink">{n === null ? "—" : n.toFixed(dp)}</div>
    </div>
  );
}

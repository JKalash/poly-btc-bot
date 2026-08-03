"use client";

import { Card, Check, Empty, Th, Td } from "../../components/ui";
import { fmtTs, u6, useApi } from "../../lib/hooks";
import { cents6, pct, signed6, signedCents6, type StrategyComparisonPayload, type StrategyRow } from "../../lib/execution";

const EMPTY_NOTE = "No strategy telemetry yet — rows appear once candidates, fills and promotion decisions are recorded.";

const f4 = (v: number | null | undefined): string => (v === null || v === undefined ? "—" : v.toFixed(4));

function PromotionBadge({ p }: { p: StrategyRow["promotion"] }) {
  if (p.status === "PROMOTED") {
    return (
      <span className="inline-flex items-center gap-1.5 border rounded px-2 py-0.5 text-[11px] font-semibold tracking-wide bg-good/15 text-good border-good/40">
        ✓ PROMOTED{p.active ? "" : " (inactive)"}
      </span>
    );
  }
  if (p.status === "NOT_PROMOTED") {
    return (
      <span
        className="inline-flex items-center gap-1.5 border rounded px-2 py-0.5 text-[11px] font-semibold tracking-wide bg-critical/15 text-critical border-critical/50"
        title={p.reasons.join("; ")}
      >
        ✕ NOT PROMOTED
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 border rounded px-2 py-0.5 text-[11px] font-semibold tracking-wide bg-panel2 text-muted border-hairline">
      NO DECISION
    </span>
  );
}

export default function StrategyComparisonPage() {
  const { data } = useApi<StrategyComparisonPayload>("/api/strategy/comparison", 20_000);
  const strategies = data?.strategies ?? [];
  const fsc = data?.fillSelectionCost ?? null;

  return (
    <div className="space-y-4">
      <div className="border border-warning/40 bg-warning/10 rounded-lg px-4 py-3 text-warning text-[13px] font-semibold">
        ⚠ Score strength is not probability — only walk-forward calibration (Brier, log-loss, ECE) says whether a score
        can be trusted as a price.
      </div>

      <Card title="Strategy comparison · all figures fill-conditioned unless noted">
        {strategies.length === 0 ? <Empty text={EMPTY_NOTE} /> : (
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap">
              <thead>
                <tr>
                  <Th>Strategy</Th><Th>Promotion</Th>
                  <Th>Samples</Th><Th>Candidates</Th><Th>Approved</Th><Th>Fills</Th>
                  <Th>Avg price paid</Th><Th>Win rate</Th>
                  <Th>Brier</Th><Th>Log loss</Th><Th>ECE</Th>
                  <Th>Gross/trade</Th><Th>Fees/trade</Th><Th>Slip/share</Th><Th>Adverse 30s</Th><Th>Net/trade</Th>
                  <Th>Net CI (95%)</Th><Th>Net EV/cost (CI)</Th>
                  <Th>Max DD</Th><Th>Loss streak</Th>
                </tr>
              </thead>
              <tbody>
                {strategies.map((s) => {
                  const o = s.outcomes;
                  const resolved = o?.resolved ?? 0;
                  const avg = (v6: string | undefined): string =>
                    o && resolved > 0 && v6 !== undefined ? signed6((BigInt(v6) / BigInt(resolved)).toString()) : "—";
                  const ev = s.evidence;
                  const netN = o ? Number(o.net6) : 0;
                  return (
                    <tr key={s.strategyVersion}>
                      <Td className="font-semibold text-ink">{s.strategyVersion}</Td>
                      <Td><PromotionBadge p={s.promotion} /></Td>
                      <Td className="num">{ev?.n ?? "—"}</Td>
                      <Td className="num">{s.candidates.total}</Td>
                      <Td className="num">{s.candidates.approved}</Td>
                      <Td className="num">{s.fills.count}</Td>
                      <Td className="num">{cents6(s.fills.avgPrice6)}</Td>
                      <Td className="num">{o ? pct(o.wins, resolved) : "—"}</Td>
                      <Td className="num">{f4(ev?.brier ?? s.calibration?.brier)}</Td>
                      <Td className="num">{f4(ev?.logLoss ?? s.calibration?.logLoss)}</Td>
                      <Td className="num">{f4(ev?.ece ?? s.calibration?.ece)}</Td>
                      <Td className="num">{avg(o?.gross6)}</Td>
                      <Td className="num text-muted">{avg(o?.fees6)}</Td>
                      <Td className="num">{signedCents6(s.fills.slippagePerShare6)}</Td>
                      <Td className={`num ${s.adverse && Number(s.adverse.avgMarkout30s6) < 0 ? "text-critical" : ""}`}>
                        {s.adverse ? `${signedCents6(s.adverse.avgMarkout30s6)} (n=${s.adverse.n})` : "—"}
                      </Td>
                      <Td className={`num font-semibold ${netN > 0 ? "text-good" : netN < 0 ? "text-critical" : ""}`}>{avg(o?.net6)}</Td>
                      <Td className="num">{o?.ci6 ? `${signed6(o.ci6.lo)} … ${signed6(o.ci6.hi)}` : "—"}</Td>
                      <Td className="num">
                        {ev?.netEvPerCost
                          ? `${ev.netEvPerCost.mean.toFixed(4)} (${ev.netEvPerCost.ciLo.toFixed(4)} … ${ev.netEvPerCost.ciHi.toFixed(4)})`
                          : "—"}
                      </Td>
                      <Td className="num text-critical">{o ? u6(o.maxDrawdown6) : "—"}</Td>
                      <Td className="num">{o?.longestLossStreak ?? "—"}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[11px] text-muted mt-3">
          Gross/fees/net are realized per-trade averages over resolved positions (micro-exact sums, divided at display).
          Slip/share is execution vs quoted limit; adverse 30s is the average side-adjusted markout 30s after fill.
          A strategy that is not promoted places no orders — no trade is a valid decision.
        </p>
      </Card>

      <div className="grid grid-cols-2 gap-4">
        <Card title="Fill-selection cost · signal-conditioned vs fill-conditioned (portfolio-level)">
          {!fsc ? <Empty text="No conditioning window computed yet." /> : (
            <dl className="text-[13px] space-y-2">
              <div className="flex justify-between"><dt className="text-muted">Signal-conditioned value</dt>
                <dd className="num text-ink">{signed6(fsc.signalConditionedValue6)} · n={fsc.signalSampleCount}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Fill-conditioned value</dt>
                <dd className="num text-ink">{signed6(fsc.fillConditionedValue6)} · n={fsc.fillSampleCount}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Selection cost (signal − fill)</dt>
                <dd className={`num font-semibold ${Number(fsc.cost6) > 0 ? "text-critical" : "text-good"}`}>{signed6(fsc.cost6)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Window</dt>
                <dd className="num text-muted">{fmtTs(fsc.windowStartMs)} → {fmtTs(fsc.windowEndMs)}</dd></div>
            </dl>
          )}
          <p className="text-[11px] text-muted mt-3">
            A positive cost means the trades we actually got were worse than the signals we acted on —
            being filled can be adverse information. This is measured across strategies, not per strategy.
          </p>
        </Card>

        <Card title="Promotion detail per strategy">
          {strategies.length === 0 ? <Empty text={EMPTY_NOTE} /> : (
            <div className="space-y-4">
              {strategies.map((s) => (
                <div key={s.strategyVersion} className="border border-hairline rounded-lg px-4 py-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-semibold text-ink text-[13px]">{s.strategyVersion}</span>
                    <PromotionBadge p={s.promotion} />
                  </div>
                  {s.promotion.status === "NO_DECISION" ? (
                    <p className="text-[12px] text-muted">No promotion decision recorded yet.</p>
                  ) : (
                    <>
                      <div className="text-[11px] text-muted mb-1.5">
                        {s.promotion.mode} · decided {fmtTs(s.promotion.decidedAtMs)}
                      </div>
                      {s.promotion.reasons.length > 0 && (
                        <ul className="text-[12px] text-ink2 space-y-0.5 mb-2 list-disc list-inside">
                          {s.promotion.reasons.map((r) => <li key={r}>{r}</li>)}
                        </ul>
                      )}
                      {s.evidence?.frictions && (
                        <div className="flex gap-4 text-[11px] text-muted">
                          <span><Check pass={s.evidence.frictions.feesIncluded} /> fees</span>
                          <span><Check pass={s.evidence.frictions.spreadIncluded} /> spread</span>
                          <span><Check pass={s.evidence.frictions.latencyIncluded} /> latency</span>
                          <span><Check pass={s.evidence.frictions.adverseSelectionIncluded} /> adverse selection</span>
                          {s.evidence.folds !== null && (
                            <span className="num">{s.evidence.folds} folds{s.evidence.purged ? ", purged" : ", NOT purged"}</span>
                          )}
                        </div>
                      )}
                      {s.calibration && (
                        <div className="text-[11px] text-muted mt-1.5 num">
                          calibration: {s.calibration.method} · Brier {f4(s.calibration.brier)} · log-loss {f4(s.calibration.logLoss)} · ECE {f4(s.calibration.ece)} · n={s.calibration.n}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

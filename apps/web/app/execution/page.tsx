"use client";

import { useMemo, useState } from "react";
import { HBarRows, LatencyWaterfall, MarkoutCurve, type BarRowDatum, type LatencyStageDatum } from "../../components/charts";
import { Card, Empty, Stat, Th, Td } from "../../components/ui";
import { fmtTs, u6, useApi } from "../../lib/hooks";
import {
  FUNNEL_ORDER, HORIZON_LABEL, HORIZON_ORDER, LATENCY_OTHER_STAGES, LATENCY_PATH_STAGES,
  PAPER_VARIANTS, SIDE_STATES, VARIANT_NOTES, cents6, pct, shortId, signed6, signedCents6, usFmt,
  type FillQualityPayload, type FunnelPayload, type IntentTimeline, type LatencyPayload,
  type MarkoutPayload, type PaperVariantsPayload, type QueuePayload, type TimelinesPayload,
} from "../../lib/execution";

const EMPTY_NOTE = "No data yet — populates once the engine records execution telemetry.";

export default function ExecutionLabPage() {
  const funnel = useApi<FunnelPayload>("/api/execution/funnel", 15_000);
  const quality = useApi<FillQualityPayload>("/api/execution/fill-quality", 15_000);
  const latency = useApi<LatencyPayload>("/api/execution/latency", 15_000);
  const markout = useApi<MarkoutPayload>("/api/execution/markout", 15_000);
  const variants = useApi<PaperVariantsPayload>("/api/execution/paper-variants", 15_000);
  const queue = useApi<QueuePayload>("/api/execution/queue", 15_000);

  const [intentFilter, setIntentFilter] = useState("");
  const timelinePath = intentFilter.trim()
    ? `/api/execution/timelines?intentId=${encodeURIComponent(intentFilter.trim())}`
    : "/api/execution/timelines?limit=25";
  const timelines = useApi<TimelinesPayload>(timelinePath, 15_000);
  const [selected, setSelected] = useState<string | null>(null);

  // ---- funnel rows in canonical state-machine order ----
  const funnelRows: BarRowDatum[] = useMemo(() => {
    const by = new Map((funnel.data?.states ?? []).map((s) => [s.state, s.intents]));
    const top = by.get(FUNNEL_ORDER[0]) ?? funnel.data?.totalIntents ?? 0;
    const path = FUNNEL_ORDER.map((st) => ({
      label: st, count: by.get(st) ?? 0,
      sub: top > 0 ? pct(by.get(st) ?? 0, top, 0) : undefined,
    }));
    const side = SIDE_STATES.filter((st) => (by.get(st) ?? 0) > 0)
      .map((st) => ({ label: st, count: by.get(st) ?? 0, dim: true }));
    return [...path, ...side];
  }, [funnel.data]);

  // ---- latency waterfall (cumulative p50 along SIGN→SEND→ACK) ----
  const latencyRows: LatencyStageDatum[] = useMemo(() => {
    const by = new Map((latency.data?.stages ?? []).map((s) => [s.stage, s]));
    let offset = 0;
    const rows: LatencyStageDatum[] = [];
    for (const st of LATENCY_PATH_STAGES) {
      const s = by.get(st);
      if (!s) continue;
      rows.push({ stage: st, n: s.n, p50Us: s.p50Us, p90Us: s.p90Us, offsetUs: offset });
      offset += s.p50Us;
    }
    for (const st of LATENCY_OTHER_STAGES) {
      const s = by.get(st);
      if (s) rows.push({ stage: st, n: s.n, p50Us: s.p50Us, p90Us: s.p90Us, offsetUs: 0, independent: true });
    }
    return rows;
  }, [latency.data]);

  // ---- markout points in fixed horizon order (avg = exact sum / n at the edge) ----
  const markoutPoints = useMemo(() => {
    const by = new Map((markout.data?.horizons ?? []).map((h) => [h.horizonMs, h]));
    return HORIZON_ORDER.flatMap((h) => {
      const row = by.get(h);
      if (!row || row.n === 0) return [];
      const avgMicro = Number(BigInt(row.sumMarkout6) / BigInt(row.n)); // exact integer division, format-only loss
      return [{ label: HORIZON_LABEL[h] ?? h, valueCents: (avgMicro / 1e6) * 100, n: row.n }];
    });
  }, [markout.data]);

  const q = quality.data;
  const ordersTotal = q?.orders.total ?? 0;
  const sel = timelines.data?.intents.find((i) => i.intentId === selected) ?? null;

  return (
    <div className="space-y-4">
      <div className="border border-warning/40 bg-warning/10 rounded-lg px-4 py-3 text-warning text-[13px] font-semibold">
        ⚠ Being filled can be adverse information — every fill below is scored against what the market did next.
      </div>

      {/* KPI row */}
      <div className="panel grid grid-cols-6 divide-x divide-hairline">
        <Stat label="Intents observed" value={funnel.data?.totalIntents ?? "—"} />
        <Stat label="Full fill rate" value={q ? pct(q.orders.full, ordersTotal) : "—"} sub="of orders placed" />
        <Stat label="Partial-fill rate" value={q ? pct(q.orders.partial, ordersTotal) : "—"} tone={q && q.orders.partial > 0 ? "warning" : undefined} />
        <Stat label="Missed rate" value={q ? pct(q.orders.none, ordersTotal) : "—"} sub="quoted, never filled" />
        <Stat label="Maker share of fills" value={q ? pct(q.makerTaker.makerFills, q.makerTaker.makerFills + q.makerTaker.takerFills) : "—"} />
        <Stat
          label="Cancel races lost"
          value={q ? `${q.cancelRaces.lostToFill}/${q.cancelRaces.requested}` : "—"}
          sub="fill raced the cancel"
          tone={q && q.cancelRaces.lostToFill > 0 ? "warning" : undefined}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Card title={`Signal-to-fill funnel · distinct intents per state${funnel.data ? ` · ${funnel.data.totalIntents} intents` : ""}`}>
          <HBarRows rows={funnelRows.filter((r) => r.count > 0 || !r.dim)} emptyText={EMPTY_NOTE} />
          <p className="text-[11px] text-muted mt-3">
            No trade is a valid decision. Rejections and unfilled intents are outcomes of the strategy, not failures of it.
            Score strength is not probability.
          </p>
        </Card>

        <Card title="Latency waterfall · per-stage aggregates">
          <LatencyWaterfall stages={latencyRows} emptyText={EMPTY_NOTE} />
          {latency.data && latency.data.stages.length > 0 && (
            <table className="w-full mt-3">
              <thead><tr><Th>Stage</Th><Th>N</Th><Th>p50</Th><Th>p90</Th><Th>p99</Th><Th>Max</Th></tr></thead>
              <tbody>
                {latency.data.stages.map((s) => (
                  <tr key={s.stage}>
                    <Td className="font-semibold text-ink">{s.stage}</Td>
                    <Td className="num">{s.n}</Td>
                    <Td className="num">{usFmt(s.p50Us)}</Td>
                    <Td className="num">{usFmt(s.p90Us)}</Td>
                    <Td className="num">{usFmt(s.p99Us)}</Td>
                    <Td className="num text-muted">{usFmt(s.maxUs)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Card title="Post-fill markout · avg mid move vs fill, by horizon">
          <MarkoutCurve points={markoutPoints} emptyText={EMPTY_NOTE} />
          {markout.data && markout.data.horizons.length > 0 && (
            <table className="w-full mt-3">
              <thead><tr><Th>Horizon</Th><Th>N</Th><Th>Avg markout</Th><Th>Median</Th><Th>Adverse share</Th></tr></thead>
              <tbody>
                {HORIZON_ORDER.flatMap((h) => {
                  const row = markout.data!.horizons.find((x) => x.horizonMs === h);
                  if (!row) return [];
                  const avg = row.n > 0 ? (BigInt(row.sumMarkout6) / BigInt(row.n)).toString() : null;
                  return [(
                    <tr key={h}>
                      <Td className="num">{HORIZON_LABEL[h] ?? h}</Td>
                      <Td className="num">{row.n}</Td>
                      <Td className={`num ${avg && Number(avg) < 0 ? "text-critical" : ""}`}>{signedCents6(avg)}</Td>
                      <Td className="num">{signedCents6(row.medianMarkout6)}</Td>
                      <Td className="num">{pct(row.adverseCount, row.n)}</Td>
                    </tr>
                  )];
                })}
              </tbody>
            </table>
          )}
          <p className="text-[11px] text-muted mt-3">
            Markout is side-adjusted: negative means the market moved against us after we were filled.
            Being filled can be adverse information.
          </p>
        </Card>

        <div className="space-y-4">
          <Card title="Quoted vs filled">
            {!q || (q.quoted.avgQuoted6 === null && q.quoted.avgFilled6 === null) ? <Empty text={EMPTY_NOTE} /> : (
              <div className="grid grid-cols-3 divide-x divide-hairline">
                <Stat label="Avg quoted" value={cents6(q.quoted.avgQuoted6)} sub="size-weighted limit" />
                <Stat label="Avg filled" value={cents6(q.quoted.avgFilled6)} sub="size-weighted execution" />
                <Stat
                  label="Slippage / share"
                  value={signedCents6(q.quoted.slippagePerShare6)}
                  sub="+ = paid worse than quote"
                  tone={q.quoted.slippagePerShare6 !== null && Number(q.quoted.slippagePerShare6) > 0 ? "warning" : undefined}
                />
              </div>
            )}
            {q && (
              <p className="text-[11px] text-muted mt-2">
                Maker/taker split by shares: {u6(q.makerTaker.makerShares6, 1)} maker / {u6(q.makerTaker.takerShares6, 1)} taker.
              </p>
            )}
          </Card>

          <Card title="Queue estimates & fill counterfactuals">
            {!queue.data || (queue.data.methods.length === 0 && queue.data.counterfactuals.n === 0) ? <Empty text={EMPTY_NOTE} /> : (
              <div className="space-y-3">
                {queue.data.methods.length > 0 && (
                  <table className="w-full">
                    <thead><tr><Th>Method</Th><Th>N</Th><Th>Avg ahead</Th><Th>Median ahead</Th></tr></thead>
                    <tbody>
                      {queue.data.methods.map((m) => (
                        <tr key={m.method}>
                          <Td className="font-semibold text-ink">{m.method}</Td>
                          <Td className="num">{m.n}</Td>
                          <Td className="num">{u6(m.avgAhead6, 1)} sh</Td>
                          <Td className="num">{u6(m.medianAhead6, 1)} sh</Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <div className="grid grid-cols-3 divide-x divide-hairline border-t border-hairline">
                  <Stat label="Counterfactuals" value={queue.data.counterfactuals.n} sub="would-we-have-filled checks" />
                  <Stat label="Would fill" value={pct(queue.data.counterfactuals.wouldFill, queue.data.counterfactuals.n)} />
                  <Stat label="Would miss" value={pct(queue.data.counterfactuals.n - queue.data.counterfactuals.wouldFill, queue.data.counterfactuals.n)} />
                </div>
                {queue.data.counterfactuals.reasons.length > 0 && (
                  <ul className="text-[11px] text-muted space-y-0.5">
                    {queue.data.counterfactuals.reasons.map((r) => (
                      <li key={r.reason}><span className="text-ink2">{r.reason}</span> · n={r.n} · would fill {pct(r.wouldFill, r.n, 0)}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Card>
        </div>
      </div>

      {/* Paper variants — three assumptions, never merged */}
      <Card title="Paper P&L under three fill assumptions (side by side — never merged into one number)">
        <div className="grid grid-cols-3 gap-4">
          {PAPER_VARIANTS.map((v) => {
            const row = variants.data?.variants.find((x) => x.variant === v) ?? null;
            const net = row ? Number(row.net6) : 0;
            return (
              <div key={v} className="border border-hairline rounded-lg">
                <div className="px-4 py-2.5 border-b border-hairline flex items-center justify-between">
                  <span className="text-[12px] uppercase tracking-wider font-semibold text-ink">{v.replace(/_/g, " ")}</span>
                  {v === "QUEUE_REPLAY" && <span className="text-[10px] text-muted uppercase tracking-wide">default paper path</span>}
                </div>
                {!row || row.decisions === 0 ? (
                  <Empty text={EMPTY_NOTE} />
                ) : (
                  <dl className="text-[13px] px-4 py-3 space-y-1.5">
                    <div className="flex justify-between"><dt className="text-muted">Net (after fees)</dt>
                      <dd className={`num font-semibold ${net > 0 ? "text-good" : net < 0 ? "text-critical" : "text-ink"}`}>{signed6(row.net6)}</dd></div>
                    <div className="flex justify-between"><dt className="text-muted">Gross / fees</dt>
                      <dd className="num">{signed6(row.gross6)} / -{u6(row.fees6)}</dd></div>
                    <div className="flex justify-between"><dt className="text-muted">Decisions / filled / resolved</dt>
                      <dd className="num">{row.decisions} / {row.filledCount} / {row.resolved}</dd></div>
                    <div className="flex justify-between"><dt className="text-muted">Win rate</dt>
                      <dd className="num">{pct(row.wins, row.resolved)}</dd></div>
                    <div className="flex justify-between"><dt className="text-muted">Avg fill price</dt>
                      <dd className="num">{cents6(row.avgFillPrice6)}</dd></div>
                    <div className="flex justify-between"><dt className="text-muted">Max drawdown</dt>
                      <dd className="num text-critical">{u6(row.maxDrawdown6)}</dd></div>
                    <div className="flex justify-between"><dt className="text-muted">Longest loss streak</dt>
                      <dd className="num">{row.longestLossStreak}</dd></div>
                  </dl>
                )}
                <p className="text-[11px] text-muted px-4 pb-3">{VARIANT_NOTES[v]}</p>
              </div>
            );
          })}
        </div>
        <p className="text-[11px] text-muted mt-3">
          The spread between OPTIMISTIC_TOUCH and CONSERVATIVE_STRESS is the fill-assumption uncertainty band.
          pnl_records (P&L Analytics page) remain the QUEUE_REPLAY path. No trade is a valid decision.
        </p>
      </Card>

      {/* Execution timelines */}
      <Card
        title="Execution timelines · recent intents"
        right={
          <input
            value={intentFilter}
            onChange={(e) => { setIntentFilter(e.target.value); setSelected(null); }}
            placeholder="filter by intent id…"
            className="bg-page border border-hairline rounded px-2 py-1 text-[12px] w-64"
          />
        }
      >
        {!timelines.data || timelines.data.intents.length === 0 ? (
          <Empty text={intentFilter ? "No timeline for that intent id." : EMPTY_NOTE} />
        ) : (
          <table className="w-full">
            <thead><tr><Th>Intent</Th><Th>Mode</Th><Th>Last state</Th><Th>Events</Th><Th>Attempts</Th><Th>First event</Th><Th>Span</Th></tr></thead>
            <tbody>
              {timelines.data.intents.map((it) => (
                <tr key={it.intentId}
                  onClick={() => setSelected(selected === it.intentId ? null : it.intentId)}
                  className={`cursor-pointer hover:bg-panel2 ${selected === it.intentId ? "bg-panel2" : ""}`}>
                  <Td className="num text-ink">{shortId(it.intentId)}</Td>
                  <Td>{it.mode}</Td>
                  <Td className={`font-semibold ${it.lastState === "FILLED" ? "text-good" : it.lastState === "UNKNOWN_OUTCOME" ? "text-critical" : "text-ink2"}`}>{it.lastState}</Td>
                  <Td className="num">{it.events.length}</Td>
                  <Td className="num">{it.attempts.length}</Td>
                  <Td className="num text-muted">{fmtTs(it.firstTsMs)}</Td>
                  <Td className="num">{it.lastTsMs - it.firstTsMs}ms</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {sel && <TimelineDetail intent={sel} />}
      </Card>
    </div>
  );
}

function TimelineDetail({ intent }: { intent: IntentTimeline }) {
  return (
    <div className="mt-4 pt-4 border-t border-hairline grid grid-cols-2 gap-4">
      <div>
        <h3 className="text-[11px] uppercase tracking-wider text-muted mb-2">Event sequence · intent {shortId(intent.intentId)}</h3>
        <ol className="space-y-1 text-[12px]">
          {intent.events.map((e) => (
            <li key={e.id} className="flex items-center gap-3">
              <span className="num text-muted w-20 text-right shrink-0">+{e.tsMs - intent.firstTsMs}ms</span>
              <span className={`font-semibold ${e.state === "FILLED" ? "text-good" : e.state === "REJECTED" || e.state === "UNKNOWN_OUTCOME" ? "text-critical" : "text-ink"}`}>{e.state}</span>
              {e.attemptId && <span className="text-muted num">attempt {shortId(e.attemptId)}</span>}
            </li>
          ))}
        </ol>
      </div>
      <div>
        <h3 className="text-[11px] uppercase tracking-wider text-muted mb-2">Order attempts</h3>
        {intent.attempts.length === 0 ? <Empty text="No attempts recorded for this intent." /> : (
          <table className="w-full">
            <thead><tr><Th>#</Th><Th>Side</Th><Th>Price</Th><Th>Size</Th><Th>Remaining</Th><Th>TIF</Th><Th>Status</Th></tr></thead>
            <tbody>
              {intent.attempts.map((a) => (
                <tr key={a.id}>
                  <Td className="num">{a.attemptNumber}</Td>
                  <Td className="font-semibold text-ink">{a.side}{a.postOnly ? " (post)" : ""}</Td>
                  <Td className="num">{cents6(a.price6)}</Td>
                  <Td className="num">{u6(a.size6, 1)}</Td>
                  <Td className="num">{u6(a.remaining6, 1)}</Td>
                  <Td>{a.timeInForce}</Td>
                  <Td className="font-semibold">{a.status}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

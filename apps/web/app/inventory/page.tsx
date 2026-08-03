"use client";

import { useMemo, useState } from "react";
import { HBarRows, type BarRowDatum } from "../../components/charts";
import { Card, Empty, Meter, SideTag, Stat, Th, Td } from "../../components/ui";
import { fmtTs, u6, useApi } from "../../lib/hooks";
import { cents6, pct, shortId, signed6 } from "../../lib/execution";
import {
  ACCRUAL_STATE_CLS, ACCRUAL_STATE_ORDER, CYCLE_MAIN_PATH, CYCLE_SIDE_STATES, CYCLE_STATE_CLS,
  EXPOSED_CYCLE_STATES, LEG_SIDE_STATES, LEG_STATE_CLS, OP_STATE_CLS, SIM_OFF_NOTE,
  epochFmt, msFmt, ppmFmt,
  type AccrualLedger, type AccrualsPayload, type BasisPayload, type CtfOperationRow,
  type CycleRow, type CyclesPayload, type SnapshotsPayload, type SummaryPayload,
} from "../../lib/inventory";

const FUNNEL_EMPTY =
  `No paired quote cycles recorded yet. ${SIM_OFF_NOTE} The funnel populates when the R10 simulator plans split-sell / buy-both-merge cycles.`;
const OPEN_LEG_EMPTY =
  `No open one-leg exposure right now. Rows appear the moment exactly one leg of a paired quote has net fills — from that instant the book is directional. ${SIM_OFF_NOTE}`;
const ACCRUAL_EMPTY =
  `No accruals recorded yet. Rows appear when simulated maker fills accrue rebates (per fill) or resting quotes qualify for liquidity rewards (per epoch). ${SIM_OFF_NOTE}`;
const OPS_EMPTY =
  `No CTF operations yet. Split / merge / redeem rows appear when the simulator models inventory operations with gas, latency and partial confirmation. ${SIM_OFF_NOTE}`;
const SNAPSHOT_EMPTY =
  `No inventory snapshots yet. The simulator writes believed vs exchange vs on-chain balances per market as it runs. ${SIM_OFF_NOTE}`;
const BASIS_EMPTY =
  "No feed-basis estimates yet — rows arrive once the cross-feed basis estimator (R1) runs over captured Binance/Chainlink data.";
const BOUNDARY_EMPTY =
  "No boundary observations captured yet — rows arrive from authoritative Chainlink boundary capture at window open/close.";

function StateBadgeSmall({ state, clsMap }: { state: string; clsMap: Record<string, string> }) {
  const cls = clsMap[state] ?? "bg-panel2 text-ink2 border-hairline";
  return (
    <span className={`inline-flex items-center border rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide whitespace-nowrap ${cls}`}>
      {state}
    </span>
  );
}

function RiskFreeTag({ riskFree }: { riskFree: boolean }) {
  return riskFree ? (
    <span
      className="inline-flex items-center border rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide whitespace-nowrap bg-good/15 text-good border-good/40"
      title="Domain isRiskFree: cycle RECONCILED and every leg closed (HEDGED / CANCELED / SETTLED)."
    >
      RISK-FREE · RECONCILED
    </span>
  ) : (
    <span
      className="inline-flex items-center border rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide whitespace-nowrap bg-panel2 text-warning border-warning/40"
      title="A split position is not risk-free while a leg is open."
    >
      NOT RISK-FREE
    </span>
  );
}

/** Recorded unhedged duration, or the live elapsed time for an ongoing exposure. */
function unhedgedMsOf(c: CycleRow): { ms: number | null; ongoing: boolean } {
  if (c.unhedgedDurationMs !== null) return { ms: c.unhedgedDurationMs, ongoing: false };
  if (c.oneLegFilledAtMs !== null && c.hedgeCompletedAtMs === null && EXPOSED_CYCLE_STATES.has(c.state)) {
    return { ms: Date.now() - c.oneLegFilledAtMs, ongoing: true };
  }
  return { ms: null, ongoing: false };
}

export default function InventoryLabPage() {
  const [stateFilter, setStateFilter] = useState("");
  const cyclesPath = stateFilter
    ? `/api/inventory/cycles?limit=50&state=${encodeURIComponent(stateFilter)}`
    : "/api/inventory/cycles?limit=50";
  const cycles = useApi<CyclesPayload>(cyclesPath, 15_000);
  const summary = useApi<SummaryPayload>("/api/inventory/summary", 15_000);
  const accruals = useApi<AccrualsPayload>("/api/inventory/accruals", 30_000);
  const snapshots = useApi<SnapshotsPayload>("/api/inventory/snapshots?limit=25", 30_000);
  const basis = useApi<BasisPayload>("/api/inventory/basis", 30_000);
  const [openCycleId, setOpenCycleId] = useState<string | null>(null);

  const s = summary.data;
  const capMs = s?.unhedged.capMs ?? 2000;

  // ---- cycle state distribution in machine order (main path + dim side states) ----
  const funnelRows: BarRowDatum[] = useMemo(() => {
    const by = new Map((s?.cycles.byState ?? []).map((r) => [r.state, r.n]));
    const total = s?.cycles.total ?? 0;
    const path = CYCLE_MAIN_PATH.map((st) => ({
      label: st,
      count: by.get(st) ?? 0,
      sub: total > 0 ? pct(by.get(st) ?? 0, total, 0) : undefined,
    }));
    const side = CYCLE_SIDE_STATES.filter((st) => (by.get(st) ?? 0) > 0)
      .map((st) => ({ label: st, count: by.get(st) ?? 0, dim: true }));
    return [...path, ...side];
  }, [s]);

  const legSideCounts = useMemo(() => {
    const by = new Map((s?.legs.byState ?? []).map((r) => [r.state, r.n]));
    return LEG_SIDE_STATES.map((st) => ({ state: st, n: by.get(st) ?? 0 }));
  }, [s]);

  const exposedCycles = useMemo(
    () =>
      (cycles.data?.cycles ?? []).filter(
        (c) =>
          EXPOSED_CYCLE_STATES.has(c.state) ||
          c.legs.some((l) => (LEG_SIDE_STATES as readonly string[]).includes(l.state)),
      ),
    [cycles.data],
  );

  const anyNote = summary.data?.note ?? cycles.data?.note ?? accruals.data?.note ?? snapshots.data?.note ?? basis.data?.note;
  const recentOps = s?.operations.recent ?? [];
  const paidRebates6 = accruals.data?.makerRebate.realized.paid6 ?? "0";
  const paidRewards6 = accruals.data?.liquidityReward.realized.paid6 ?? "0";

  return (
    <div className="space-y-4">
      <div className="border border-serious/40 bg-serious/10 rounded-lg px-4 py-3 text-serious text-[13px] font-semibold">
        ⚠ A split position is not risk-free while a leg is open. One-leg exposure is directional risk — nothing below
        is labeled risk-free unless the cycle is RECONCILED and every leg is closed.
      </div>
      <p className="text-[12px] text-muted">
        {SIM_OFF_NOTE} Everything on this page is read-only telemetry over the R10 paired-cycle simulation tables.
      </p>
      {anyNote && <p className="text-[12px] text-warning">{anyNote}</p>}

      {/* KPI row */}
      <div className="panel grid grid-cols-7 divide-x divide-hairline">
        <Stat label="Cycles observed" value={s?.cycles.total ?? "—"} sub={s ? `${s.worstCaseLoss.open.n} not yet reconciled` : undefined} />
        <Stat
          label="One-leg incidence"
          value={s ? pct(s.cycles.oneLegFilled, s.cycles.total) : "—"}
          sub="cycles that ever had exactly one leg filled"
          tone={s && s.cycles.oneLegFilled > 0 ? "warning" : undefined}
        />
        <Stat
          label="Open worst-case loss"
          value={s ? `$${u6(s.worstCaseLoss.open.sum6)}` : "—"}
          sub="planned failure-path loss, unreconciled cycles"
        />
        <Stat
          label="Longest unhedged"
          value={s ? msFmt(s.unhedged.maxMs) : "—"}
          sub={s ? `cap ${msFmt(capMs)} · ${s.unhedged.overCapCount} over cap` : undefined}
          tone={s && s.unhedged.overCapCount > 0 ? "critical" : undefined}
        />
        <Stat
          label="UNKNOWN CTF ops"
          value={s?.operations.unknownOutcomes ?? "—"}
          sub="must reconcile on-chain first"
          tone={s && s.operations.unknownOutcomes > 0 ? "critical" : undefined}
        />
        <Stat
          label="Paid rebates"
          value={accruals.data ? `$${u6(paidRebates6)}` : "—"}
          sub="MAKER_REBATE · PAID only"
          tone={Number(paidRebates6) > 0 ? "good" : undefined}
        />
        <Stat
          label="Paid liquidity rewards"
          value={accruals.data ? `$${u6(paidRewards6)}` : "—"}
          sub="LIQUIDITY_REWARD · PAID only"
          tone={Number(paidRewards6) > 0 ? "good" : undefined}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Cycle state funnel */}
        <Card title={`Cycle state machine · current distribution${s ? ` · ${s.cycles.total} cycles` : ""}`}>
          <HBarRows rows={funnelRows.filter((r) => r.count > 0 || !r.dim)} emptyText={FUNNEL_EMPTY} />
          <div className="mt-3 pt-3 border-t border-hairline flex items-center gap-4 text-[12px]">
            <span className="text-[10px] uppercase tracking-wider text-muted">Leg side states</span>
            {legSideCounts.map((r) => (
              <span key={r.state} className="flex items-center gap-1.5">
                <StateBadgeSmall state={r.state} clsMap={r.n > 0 ? LEG_STATE_CLS : {}} />
                <span className={`num font-semibold ${r.n > 0 ? "text-ink" : "text-muted"}`}>{r.n}</span>
              </span>
            ))}
            <span className="text-muted ml-auto num">
              hedge completed on {s?.cycles.hedgeCompleted ?? 0} cycle{(s?.cycles.hedgeCompleted ?? 0) === 1 ? "" : "s"}
            </span>
          </div>
          <p className="text-[11px] text-muted mt-3">
            Main path in machine order, PLANNED → RECONCILED; side states (dimmed) appear only when occupied.
            PARTIAL_LEG and UNHEDGED are leg-shaped side states. RECONCILED is the sole terminal state — and
            no trade is a valid decision, so PLANNED → RECONCILED with nothing done is a legal, clean path.
          </p>
        </Card>

        {/* Open-leg risk panel */}
        <Card title={`Open-leg exposure · directional until hedged${exposedCycles.length > 0 ? ` · ${exposedCycles.length} cycle${exposedCycles.length === 1 ? "" : "s"}` : ""}`}>
          {exposedCycles.length === 0 ? (
            <Empty text={OPEN_LEG_EMPTY} />
          ) : (
            <table className="w-full">
              <thead><tr><Th>Cycle</Th><Th>State</Th><Th>Worst case</Th><Th>Unhedged vs {msFmt(capMs)} cap</Th><Th>Open legs</Th><Th>Resolution</Th></tr></thead>
              <tbody>
                {exposedCycles.map((c) => {
                  const { ms, ongoing } = unhedgedMsOf(c);
                  const over = ms !== null && ms > capMs;
                  const openLegs = c.legs.filter((l) => (LEG_SIDE_STATES as readonly string[]).includes(l.state));
                  const lastHedge = c.hedgeActions[c.hedgeActions.length - 1];
                  return (
                    <tr key={c.id} className={over ? "bg-critical/10" : ""}>
                      <Td className="num text-ink whitespace-nowrap">
                        {shortId(c.id)}
                        <span className="block text-[10px] text-muted">{c.kind} · {c.mode}</span>
                      </Td>
                      <Td><StateBadgeSmall state={c.state} clsMap={CYCLE_STATE_CLS} /></Td>
                      <Td className="num text-critical">${u6(c.worstCaseLoss6)}</Td>
                      <Td>
                        <div className={`num text-[12px] ${over ? "text-critical font-semibold" : "text-ink"}`}>
                          {msFmt(ms)}{ongoing ? " …" : ""}{over ? " — OVER CAP" : ""}
                        </div>
                        {ms !== null && <Meter value={Math.min(ms, capMs)} max={capMs} className="mt-1 w-28" />}
                      </Td>
                      <Td>
                        {openLegs.length === 0 ? (
                          <span className="text-muted">—</span>
                        ) : (
                          openLegs.map((l) => (
                            <span key={l.id} className="mr-1.5 inline-flex items-center gap-1">
                              <SideTag side={l.outcomeSide} />
                              <StateBadgeSmall state={l.state} clsMap={LEG_STATE_CLS} />
                            </span>
                          ))
                        )}
                      </Td>
                      <Td className="text-[11px] text-ink2 whitespace-nowrap">
                        {lastHedge ? `${lastHedge.kind} · ${lastHedge.state}` : "none yet"}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p className="text-[11px] text-muted mt-3">
            A split position is not risk-free while a leg is open — the surviving quote's token has repriced against
            us by construction, so being filled can be adverse information. Exposure resolves only through
            HEDGE_OR_CANCEL (complete pair / dump survivor / cancel &amp; hold) or the sibling leg filling.
          </p>
        </Card>
      </div>

      {/* Accrual ledgers — SEPARATE programs, side by side, never merged */}
      <div className="grid grid-cols-2 gap-4">
        <LedgerCard
          title="Maker rebate ledger · MAKER_REBATE"
          ledger={accruals.data?.makerRebate ?? null}
          loaded={accruals.data !== null}
        />
        <LedgerCard
          title="Liquidity reward ledger · LIQUIDITY_REWARD"
          ledger={accruals.data?.liquidityReward ?? null}
          loaded={accruals.data !== null}
        />
      </div>
      <div className="border border-hairline bg-panel rounded-lg px-4 py-2.5 text-[12px] text-ink2">
        <span className="font-semibold text-ink">Rewards are revenue only when paid.</span>{" "}
        Rebate not included until paid. Unpaid accruals NEVER count toward EV — the two programs above have separate
        eligibility, separate accounting, and are never merged into one number.
      </div>

      {/* CTF operations */}
      <Card title="CTF operations · split / merge / redeem with gas + confirmation truth">
        {s && s.operations.unknownOutcomes > 0 && (
          <div className="border border-critical/50 bg-critical/15 rounded-lg px-4 py-2.5 mb-3 text-critical text-[13px] font-semibold">
            ⚠ {s.operations.unknownOutcomes} operation{s.operations.unknownOutcomes === 1 ? "" : "s"} with UNKNOWN
            outcome — ambiguous on-chain result. Nothing may proceed on this inventory until reconciliation resolves it.
          </div>
        )}
        <div className="grid grid-cols-4 divide-x divide-hairline border border-hairline rounded-lg mb-3">
          {(s?.operations.byKind ?? []).map((k) => (
            <Stat
              key={k.kind}
              label={k.kind}
              value={k.n}
              sub={`${k.confirmed} confirmed · ${k.partiallyConfirmed} partial · ${k.failed} failed · ${k.unknown} unknown`}
              tone={k.unknown > 0 ? "critical" : undefined}
            />
          ))}
          <Stat
            label="Gas est → actual"
            value={s ? `$${u6(s.operations.estGas6)} → $${u6(s.operations.actualGas6)}` : "—"}
            sub="modeled vs confirmed, all ops"
          />
        </div>
        {recentOps.length === 0 ? (
          <Empty text={OPS_EMPTY} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <Th>Op</Th><Th>Kind</Th><Th>State</Th><Th>Cycle</Th><Th>Requested → confirmed</Th>
                  <Th>Gas est → actual</Th><Th>Collateral Δ</Th><Th>Tx / failure</Th><Th>Created</Th>
                </tr>
              </thead>
              <tbody>
                {recentOps.map((op) => <OpRow key={op.id} op={op} />)}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[11px] text-muted mt-3">
          UNKNOWN is a first-class outcome, not an error to hide: an op whose transaction result is ambiguous blocks
          retries until on-chain reconciliation. Gas shows the pre-submit estimate and the post-confirm actual side by
          side; relayed ops pay gas indirectly.
        </p>
      </Card>

      <div className="grid grid-cols-2 gap-4">
        {/* Inventory reconciliation */}
        <Card title={`Inventory reconciliation · believed vs exchange vs on-chain${snapshots.data ? ` · ${snapshots.data.totals.mismatches} mismatch${snapshots.data.totals.mismatches === 1 ? "" : "es"}` : ""}`}>
          {(snapshots.data?.snapshots ?? []).length === 0 ? (
            <Empty text={SNAPSHOT_EMPTY} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <Th>When</Th><Th>Market</Th><Th>Believed Up/Down</Th><Th>Paired</Th><Th>Reserved</Th>
                    <Th>Exchange</Th><Th>On-chain</Th><Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {snapshots.data!.snapshots.map((r) => (
                    <tr key={r.id} className={r.reconciled ? "" : "bg-serious/10"}>
                      <Td className="num text-muted whitespace-nowrap">{fmtTs(r.tsMs).slice(5)}</Td>
                      <Td className="num text-ink2 whitespace-nowrap">{shortId(r.marketId)}<span className="block text-[10px] text-muted">{r.mode}</span></Td>
                      <Td className="num">{u6(r.upShares6, 1)} / {u6(r.downShares6, 1)}</Td>
                      <Td className="num">{u6(r.pairedShares6, 1)}<span className="text-muted text-[10px]"> (+{u6(r.unpairedUpShares6, 1)}u/{u6(r.unpairedDownShares6, 1)}d)</span></Td>
                      <Td className="num text-muted">{u6(r.reservedUpShares6, 1)} / {u6(r.reservedDownShares6, 1)}</Td>
                      <Td className="num">{r.exchangeUpShares6 !== null ? `${u6(r.exchangeUpShares6, 1)} / ${u6(r.exchangeDownShares6, 1)}` : "not queried"}</Td>
                      <Td className="num">{r.onchainUpShares6 !== null ? `${u6(r.onchainUpShares6, 1)} / ${u6(r.onchainDownShares6, 1)}` : "not queried"}</Td>
                      <Td>
                        {r.reconciled ? (
                          <span className="text-good text-[11px] font-semibold whitespace-nowrap">✓ reconciled</span>
                        ) : (
                          <span className="text-serious text-[11px] font-semibold whitespace-nowrap" title={r.divergence ? JSON.stringify(r.divergence) : undefined}>
                            ✕ MISMATCH
                          </span>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[11px] text-muted mt-3">
            Reconciled means believed == exchange == on-chain for every queried figure. A mismatch drives the owning
            cycle to FAILED_RECONCILIATION and halts its inventory — hover a MISMATCH for the structured divergence.
          </p>
        </Card>

        {/* Basis + boundary */}
        <Card title="Feed basis &amp; boundary truth">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">Cross-feed basis (base − ref, ppm)</div>
          {(basis.data?.basis.pairs ?? []).length === 0 ? (
            <Empty text={BASIS_EMPTY} />
          ) : (
            <table className="w-full">
              <thead><tr><Th>Pair</Th><Th>Latest mean</Th><Th>Std</Th><Th>Lead/lag</Th><Th>Range of means</Th><Th>N</Th></tr></thead>
              <tbody>
                {basis.data!.basis.pairs.map((p) => (
                  <tr key={`${p.symbol}-${p.baseSource}-${p.refSource}`}>
                    <Td className="text-ink whitespace-nowrap">
                      {p.symbol} <span className="text-muted text-[11px]">{p.baseSource} − {p.refSource}</span>
                      <span className="block text-[10px] text-muted">{p.latest.method}{p.latest.regime ? ` · ${p.latest.regime}` : ""} · as of {fmtTs(p.latest.tsMs).slice(5)}</span>
                    </Td>
                    <Td className="num text-ink">{ppmFmt(p.latest.meanPpm)}</Td>
                    <Td className="num">{p.latest.stdPpm.toFixed(1)}</Td>
                    <Td className="num">{p.latest.leadLagMs !== null ? `${p.latest.leadLagMs > 0 ? "+" : ""}${Math.round(p.latest.leadLagMs)}ms` : "—"}</Td>
                    <Td className="num text-muted">{ppmFmt(p.meanPpmMin, 0)} … {ppmFmt(p.meanPpmMax, 0)}</Td>
                    <Td className="num">{p.estimates}<span className="text-muted text-[10px]"> est / {p.samples.toLocaleString("en-US")} ticks</span></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="text-[11px] text-muted mt-2 mb-3">
            Structural basis is subtracted before anything is called a lag signal — an offset that fires a gate
            structurally is a fake edge (the brief's ETH 0.12% lesson).
          </p>

          <div className="mb-1 pt-3 border-t border-hairline text-[10px] uppercase tracking-wider text-muted">Boundary observations (authoritative strike / resolution capture)</div>
          {!basis.data || basis.data.boundary.totals.n === 0 ? (
            <Empty text={BOUNDARY_EMPTY} />
          ) : (
            <>
              <div className="grid grid-cols-4 divide-x divide-hairline border border-hairline rounded-lg mb-2">
                <Stat label="Captured" value={basis.data.boundary.totals.n} sub={basis.data.boundary.byKind.map((k) => `${k.n} ${k.kind}`).join(" · ")} />
                <Stat label="Official match" value={basis.data.boundary.totals.matched} tone={basis.data.boundary.totals.matched > 0 ? "good" : undefined} />
                <Stat
                  label="Official mismatch"
                  value={basis.data.boundary.totals.mismatched}
                  tone={basis.data.boundary.totals.mismatched > 0 ? "critical" : undefined}
                  sub={`${basis.data.boundary.totals.unchecked} unchecked`}
                />
                <Stat
                  label="Late captures"
                  value={basis.data.boundary.totals.lateCaptures}
                  sub="not authoritative"
                  tone={basis.data.boundary.totals.lateCaptures > 0 ? "warning" : undefined}
                />
              </div>
              <table className="w-full">
                <thead><tr><Th>Boundary</Th><Th>Kind</Th><Th>Value</Th><Th>Source</Th><Th>Authoritative</Th><Th>Official</Th></tr></thead>
                <tbody>
                  {basis.data.boundary.recent.map((b) => (
                    <tr key={b.id}>
                      <Td className="num text-muted whitespace-nowrap">{epochFmt(b.boundaryEpoch).slice(5)}</Td>
                      <Td className="text-ink2">{b.symbol} {b.boundaryKind}</Td>
                      <Td className="num text-ink">{b.valueText}</Td>
                      <Td className="text-muted text-[11px]">{b.source}</Td>
                      <Td>
                        {b.firstAtOrAfterBoundary ? (
                          <span className="text-good text-[11px] font-semibold">✓ first at/after</span>
                        ) : (
                          <span className="text-warning text-[11px] font-semibold" title="Capture started late; a reconstructed strike is never authoritative.">LATE — not authoritative</span>
                        )}
                      </Td>
                      <Td>
                        {b.matchesOfficial === true ? <span className="text-good text-[11px]">✓ matches</span>
                          : b.matchesOfficial === false ? <span className="text-critical text-[11px] font-semibold" title={`official: ${b.officialValueText ?? "?"}`}>✕ differs</span>
                          : <span className="text-muted text-[11px]">unchecked</span>}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <p className="text-[11px] text-muted mt-3">
            Binance is not the resolution source. Only the first authoritative Chainlink tick at/after the 300s
            boundary defines strike and resolution; the official price-to-beat cross-check keeps us honest.
          </p>
        </Card>
      </div>

      {/* Recent cycles */}
      <Card
        title="Recent paired cycles"
        right={
          <select
            value={stateFilter}
            onChange={(e) => { setStateFilter(e.target.value); setOpenCycleId(null); }}
            className="bg-page border border-hairline rounded px-2 py-1 text-[12px]"
            aria-label="filter by cycle state"
          >
            <option value="">all states</option>
            {[...CYCLE_MAIN_PATH, ...CYCLE_SIDE_STATES].map((st) => <option key={st} value={st}>{st}</option>)}
          </select>
        }
      >
        {(cycles.data?.cycles ?? []).length === 0 ? (
          <Empty text={stateFilter ? `No cycles in state ${stateFilter}.` : FUNNEL_EMPTY} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <Th>Cycle</Th><Th>Market</Th><Th>State</Th><Th>Risk</Th><Th>Pair target</Th><Th>Worst case</Th>
                  <Th>Unhedged</Th><Th>Spread captured</Th><Th>Trading P&amp;L</Th><Th>Created</Th>
                </tr>
              </thead>
              <tbody>
                {cycles.data!.cycles.map((c) => (
                  <CycleRows key={c.id} cycle={c} capMs={capMs} open={openCycleId === c.id}
                    onToggle={() => setOpenCycleId(openCycleId === c.id ? null : c.id)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[11px] text-muted mt-3">
          Trading P&amp;L never includes rebate/reward accruals until they are PAID (they live in the ledgers above).
          Click a row for legs, hedge actions and CTF operations with correlation ids.
        </p>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

function LedgerCard({ title, ledger, loaded }: { title: string; ledger: AccrualLedger | null; loaded: boolean }) {
  const empty = !ledger || ledger.byState.every((r) => r.n === 0);
  return (
    <Card title={title}>
      <div className="grid grid-cols-2 divide-x divide-hairline border border-hairline rounded-lg mb-3">
        <Stat
          label="Realized · PAID only"
          value={loaded && ledger ? `$${u6(ledger.realized.paid6)}` : "—"}
          sub={ledger ? `${ledger.realized.n} paid accrual${ledger.realized.n === 1 ? "" : "s"}` : undefined}
          tone={ledger && Number(ledger.realized.paid6) > 0 ? "good" : undefined}
        />
        <Stat
          label="Unrealized estimate"
          value={loaded && ledger ? `$${u6(ledger.unrealized.amount6)}` : "—"}
          sub="not revenue — never counts toward EV"
        />
      </div>
      {empty ? (
        <Empty text={ACCRUAL_EMPTY} />
      ) : (
        <table className="w-full">
          <thead><tr><Th>State</Th><Th>N</Th><Th>Amount</Th><Th>Meaning</Th></tr></thead>
          <tbody>
            {ACCRUAL_STATE_ORDER.map((st) => {
              const row = ledger!.byState.find((r) => r.state === st) ?? { state: st, n: 0, amount6: "0" };
              return (
                <tr key={st} className={st === "DISPUTED" && row.n > 0 ? "bg-serious/10" : ""}>
                  <Td><StateBadgeSmall state={st} clsMap={ACCRUAL_STATE_CLS} /></Td>
                  <Td className="num">{row.n}</Td>
                  <Td className="num">{`$${u6(row.amount6)}`}</Td>
                  <Td className="text-[11px] text-muted">
                    {st === "PAID" ? "realized — the only state that is revenue"
                      : st === "DISPUTED" ? (row.n > 0 ? "under dispute — re-enters the pipeline before any payment" : "")
                      : "estimate"}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {ledger && ledger.inconsistentRows > 0 && (
        <p className="text-[12px] text-critical font-semibold mt-2">
          ⚠ {ledger.inconsistentRows} row{ledger.inconsistentRows === 1 ? "" : "s"} violate the realized ⇔ PAID
          invariant — the ledger cannot be trusted until repaired.
        </p>
      )}
    </Card>
  );
}

function OpRow({ op }: { op: CtfOperationRow }) {
  const unknown = op.state === "UNKNOWN";
  return (
    <tr className={unknown ? "bg-critical/10" : ""}>
      <Td className="num text-ink whitespace-nowrap">{shortId(op.id)}<span className="block text-[10px] text-muted">{op.mode}{op.relayed ? " · relayed" : ""}</span></Td>
      <Td className="font-semibold text-ink">{op.kind}</Td>
      <Td><StateBadgeSmall state={op.state} clsMap={OP_STATE_CLS} /></Td>
      <Td className="num text-muted">{op.cycleId ? shortId(op.cycleId) : "standalone"}</Td>
      <Td className="num">{u6(op.requestedAmount6, 1)} → {op.confirmedAmount6 !== null ? u6(op.confirmedAmount6, 1) : "—"}</Td>
      <Td className="num">{op.estGasUsdc6 !== null ? `$${u6(op.estGasUsdc6, 3)}` : "—"} → {op.actualGasUsdc6 !== null ? `$${u6(op.actualGasUsdc6, 3)}` : "—"}</Td>
      <Td className="num">{signed6(op.collateralDelta6)}</Td>
      <Td className="text-[11px] max-w-[10rem]">
        {op.failureReason ? (
          <span className="text-critical block truncate" title={op.failureReason}>{op.failureReason}</span>
        ) : op.txHash ? (
          <span className="font-mono text-muted" title={op.txHash}>{shortId(op.txHash)}</span>
        ) : "—"}
      </Td>
      <Td className="num text-muted whitespace-nowrap">{fmtTs(op.createdAtMs).slice(5)}</Td>
    </tr>
  );
}

function CycleRows({ cycle: c, capMs, open, onToggle }: { cycle: CycleRow; capMs: number; open: boolean; onToggle: () => void }) {
  const { ms, ongoing } = unhedgedMsOf(c);
  const over = ms !== null && ms > capMs;
  return (
    <>
      <tr onClick={onToggle} className={`cursor-pointer hover:bg-panel2 ${open ? "bg-panel2" : ""}`}>
        <Td className="num text-ink whitespace-nowrap">{shortId(c.id)}<span className="block text-[10px] text-muted">{c.kind}</span></Td>
        <Td className="num text-ink2 whitespace-nowrap">{shortId(c.marketId)}<span className="block text-[10px] text-muted">{c.mode}</span></Td>
        <Td><StateBadgeSmall state={c.state} clsMap={CYCLE_STATE_CLS} /></Td>
        <Td><RiskFreeTag riskFree={c.riskFree} /></Td>
        <Td className="num">{cents6(c.targetPairPrice6)}</Td>
        <Td className="num text-critical">${u6(c.worstCaseLoss6)}</Td>
        <Td className={`num ${over ? "text-critical font-semibold" : ""}`}>{msFmt(ms)}{ongoing ? " …" : ""}</Td>
        <Td className="num">{c.spreadCaptured6 !== null ? signed6(c.spreadCaptured6) : "—"}</Td>
        <Td className={`num font-semibold ${c.realizedPnl6 !== null ? (Number(c.realizedPnl6) > 0 ? "text-good" : Number(c.realizedPnl6) < 0 ? "text-critical" : "text-ink") : "text-muted"}`}>
          {c.realizedPnl6 !== null ? signed6(c.realizedPnl6) : "—"}
        </Td>
        <Td className="num text-muted whitespace-nowrap">{fmtTs(c.createdAtMs).slice(5)}</Td>
      </tr>
      {open && (
        <tr className="bg-panel2/50">
          <td colSpan={10} className="px-4 py-3 border-b border-grid">
            <div className="grid grid-cols-3 gap-4 text-[12px]">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted mb-1">Legs</div>
                {c.legs.length === 0 ? <p className="text-muted">No legs recorded.</p> : (
                  <ul className="space-y-1">
                    {c.legs.map((l) => (
                      <li key={l.id} className="flex items-center gap-2 flex-wrap">
                        <SideTag side={l.outcomeSide} />
                        <span className="text-ink2">{l.orderSide}</span>
                        <StateBadgeSmall state={l.state} clsMap={LEG_STATE_CLS} />
                        <span className="num">{cents6(l.price6)} × {u6(l.size6, 1)}</span>
                        <span className="num text-muted">filled {u6(l.filledShares6, 1)}{l.avgFillPrice6 !== null ? ` @ ${cents6(l.avgFillPrice6)}` : ""}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="num text-muted mt-2">correlation {shortId(c.correlationId)} · cfg v{c.configVersion}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted mb-1">Hedge actions</div>
                {c.hedgeActions.length === 0 ? <p className="text-muted">None.</p> : (
                  <ul className="space-y-1">
                    {c.hedgeActions.map((h) => (
                      <li key={h.id} className="flex items-center gap-2 flex-wrap">
                        <span className="text-ink2">{h.kind}</span>
                        <span className={`font-semibold ${h.state === "DONE" ? "text-good" : h.state === "FAILED" ? "text-critical" : "text-ink"}`}>{h.state}</span>
                        <span className="num text-muted">
                          {u6(h.targetShares6, 1)} sh · cost {h.actualCost6 !== null ? signed6(h.actualCost6) : `est ${h.expectedCost6 !== null ? signed6(h.expectedCost6) : "—"}`}
                          {h.unhedgedDurationMs !== null ? ` · unhedged ${msFmt(h.unhedgedDurationMs)}` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted mb-1">CTF operations</div>
                {c.ctfOperations.length === 0 ? <p className="text-muted">None.</p> : (
                  <ul className="space-y-1">
                    {c.ctfOperations.map((op) => (
                      <li key={op.id} className="flex items-center gap-2 flex-wrap">
                        <span className="text-ink2">{op.kind}</span>
                        <StateBadgeSmall state={op.state} clsMap={OP_STATE_CLS} />
                        <span className="num text-muted">
                          {u6(op.requestedAmount6, 1)} req{op.confirmedAmount6 !== null ? ` · ${u6(op.confirmedAmount6, 1)} conf` : ""}
                          {op.failureReason ? ` · ${op.failureReason}` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {(c.fees6 !== null || c.spreadCaptured6 !== null) && (
                  <div className="num text-muted mt-2">
                    spread {c.spreadCaptured6 !== null ? signed6(c.spreadCaptured6) : "—"} · fees {c.fees6 !== null ? u6(c.fees6) : "—"}
                  </div>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

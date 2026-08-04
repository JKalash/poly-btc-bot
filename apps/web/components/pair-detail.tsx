import type { ReactNode } from "react";
import { Card, Empty, SideTag } from "./ui";
import { fmtTs } from "../lib/hooks";
import {
  evidenceReference, exactFields, orderedEvents, outcomeOf, recordOf, timelineStage, timelineTiming,
  type PairEffectRow, type PairGroupDetail, type PairGroupEvent, type PairJson, type PairPage,
  type PairReconciliation,
} from "../lib/pair-detail";

export function PairSafetyBanner() {
  return (
    <div className="border border-warning/50 bg-warning/10 rounded-lg px-4 py-3" role="note" aria-label="Pair capability warning">
      <div className="text-warning font-bold text-[13px] tracking-wide">RESEARCH / COUNTERFACTUAL PAPER ONLY</div>
      <div className="text-ink2 text-[12px] mt-0.5">LIVE EXECUTION DOES NOT EXIST. This screen is read-only and cannot place, alter, retry, settle, or reconcile an order.</div>
    </div>
  );
}

export function PairDetailState({ kind, message }: { kind: "loading" | "not-found" | "error"; message?: string }) {
  const heading = kind === "loading" ? "Loading pair lifecycle…" : kind === "not-found" ? "Pair group not found" : "Pair detail unavailable";
  return (
    <Card className="mt-4">
      <div role={kind === "loading" ? "status" : "alert"} aria-live="polite" className="py-10 text-center">
        <div className={kind === "error" ? "text-critical font-semibold" : "text-ink font-semibold"}>{heading}</div>
        <p className="text-muted text-[12px] mt-1">{message ?? (kind === "not-found" ? "The identifier is unknown or no longer available." : "Reading immutable pair evidence.")}</p>
      </div>
    </Card>
  );
}

export function ExactValue({ value, label }: { value: string | null | undefined; label?: string }) {
  const exact = value ?? "—";
  return <span className="num font-mono break-all" title={value === null || value === undefined ? undefined : `Exact value: ${value}`}>{exact}{label ? <span className="text-muted font-sans"> {label}</span> : null}</span>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <><dt className="text-muted">{label}</dt><dd className="text-ink min-w-0 break-words">{children}</dd></>;
}

function JsonEvidence({ value }: { value: PairJson | undefined }) {
  if (value === undefined) return null;
  return <pre className="mt-2 p-2 rounded bg-page text-[10px] text-ink2 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(value, null, 2)}</pre>;
}

function Status({ value }: { value: string }) {
  const upper = value.toUpperCase();
  const tone = upper.includes("MISMATCH") || upper.includes("UNKNOWN") || upper.includes("FAILED") || upper.includes("REJECT")
    ? "text-critical border-critical/50 bg-critical/10"
    : upper.includes("PENDING") || upper.includes("RESIDUAL") || upper.includes("PARTIAL") || upper.includes("UNREALIZED")
      ? "text-warning border-warning/50 bg-warning/10"
      : upper.includes("HEALTHY") || upper.includes("RECONCILED") || upper.includes("FILLED") || upper.includes("CONFIRMED")
        ? "text-good border-good/40 bg-good/10"
        : "text-ink2 border-hairline bg-panel2";
  return <span className={`inline-flex border rounded px-1.5 py-0.5 text-[10px] font-semibold ${tone}`}>{value}</span>;
}

export function PairDetailBanners({ group }: { group: PairGroupDetail }) {
  const residual = group.residualSide === "UP" || group.residualSide === "DOWN" || group.residualShares6 !== "0";
  const manual = group.state === "MANUAL_REVIEW" || group.reconciliationStatus === "MISMATCH";
  return (
    <div className="space-y-2">
      {residual && (
        <div className="border border-warning/60 bg-warning/15 rounded-lg px-4 py-3 text-[13px]" role="alert" aria-label={`Residual inventory ${group.residualSide ?? "side unknown"}`}>
          <span className="font-bold text-warning">RESIDUAL INVENTORY · {group.residualSide ?? "SIDE UNKNOWN"}</span>
          <span className="text-ink2"> · quantity <ExactValue value={group.residualShares6} /> · current worst-case loss <ExactValue value={group.currentWorstCaseLoss6} /></span>
          <div className="text-[11px] text-muted mt-1">State {group.state}; policy {group.recoveryPolicy}. Residual value is unrealized until authoritative settlement or resolution.</div>
        </div>
      )}
      {manual && (
        <div className="border border-critical/60 bg-critical/15 rounded-lg px-4 py-3 text-critical text-[13px] font-semibold" role="alert" aria-label="Manual review required">
          MANUAL REVIEW REQUIRED · {group.reconciliationStatus}. Evidence is preserved; this dashboard provides no repair or force-close control.
        </div>
      )}
    </div>
  );
}

function IdentityAndQuotes({ group }: { group: PairGroupDetail }) {
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      <Card title="Immutable identity & policy">
        <dl className="grid grid-cols-[minmax(8rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-[12px]">
          <Field label="Group"><ExactValue value={group.id} /></Field>
          <Field label="Market / condition">{group.marketId} / {group.conditionId ?? "—"}</Field>
          <Field label="Strategy">{group.strategyVersion}</Field>
          <Field label="Mode / route">{group.mode} / {group.route}</Field>
          <Field label="Dispatch">{group.dispatchModel}</Field>
          <Field label="Settlement policy">{group.settlementPolicy}</Field>
          <Field label="Recovery policy">{group.recoveryPolicy}</Field>
          <Field label="Request hash"><ExactValue value={group.requestHash} /></Field>
          <Field label="Correlation roots">observation {group.observationId ?? "—"}; episode {group.episodeId ?? "—"}</Field>
        </dl>
      </Card>
      <Card title="Signal & activation quotes">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <section aria-label="Signal quote">
            <h3 className="text-up text-[12px] font-semibold mb-2">SIGNAL QUOTE · PROSPECTIVE</h3>
            <dl className="space-y-1 text-[12px]">
              <Field label="Capture">{group.signalCaptureId}</Field>
              <Field label="Decision">{group.signalDecisionId ?? "—"}</Field>
              <Field label="Quoted net P&amp;L"><ExactValue value={group.signalNetPnl6} /></Field>
            </dl>
          </section>
          <section aria-label="Activation quote">
            <h3 className="text-warning text-[12px] font-semibold mb-2">ACTIVATION QUOTE</h3>
            <dl className="space-y-1 text-[12px]">
              <Field label="Capture">{group.activationCaptureId ?? "not captured"}</Field>
              <Field label="Decision">{group.activationDecisionId ?? "—"}</Field>
              <Field label="Activation net P&amp;L"><ExactValue value={group.activationNetPnl6} /></Field>
            </dl>
          </section>
        </div>
        <p className="text-[10px] text-muted mt-3">A matched terminal payout before market/operational risk is not labeled risk-free.</p>
      </Card>
    </div>
  );
}

function RiskAndReservation({ group }: { group: PairGroupDetail }) {
  return (
    <Card title="Risk gates, caps & reservation">
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3 text-[11px]">
        <Metric label="Target gross shares" value={group.targetGrossShares6} />
        <Metric label="Approved cash cap" value={group.approvedCashCap6} />
        <Metric label="Approved residual-loss cap" value={group.approvedResidualLoss6} />
        <Metric label="Reserved cash" value={group.reservedCash6} tone={group.reservedCash6 === "0" ? undefined : "warning"} />
        <Metric label="Current worst-case loss" value={group.currentWorstCaseLoss6} tone={group.currentWorstCaseLoss6.startsWith("-") ? "critical" : "warning"} />
        <Metric label="Peak worst-case loss" value={group.peakWorstCaseLoss6} />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3 text-[11px]">
        <Metric label="Cash debits" value={group.cashDebits6} />
        <Metric label="Cash credits" value={group.cashCredits6} />
        <Metric label="Cash fees" value={group.cashFees6} />
      </div>
      <JsonEvidence value={group.stressResultsJson} />
    </Card>
  );
}

function Metric({ label, value, tone }: { label: string; value: string | null | undefined; tone?: "warning" | "critical" }) {
  return <div className="border border-hairline rounded p-2"><div className="uppercase tracking-wide text-muted text-[9px]">{label}</div><div className={tone === "critical" ? "text-critical" : tone === "warning" ? "text-warning" : "text-ink"}><ExactValue value={value} /></div></div>;
}

function LegPanel({ side, group }: { side: "UP" | "DOWN"; group: PairGroupDetail }) {
  const effects = (group.effects ?? []).filter((row) => outcomeOf(row) === side);
  const lots = (group.inventoryLots ?? []).filter((row) => outcomeOf(row) === side);
  const evidence = (group.evidence ?? []).filter((row) => {
    const payloadSide = outcomeOf(row.payload ?? {});
    return payloadSide === side || effects.some((effect) => effect.id === row.effectId);
  });
  const held = side === "UP" ? group.upHeldShares6 : group.downHeldShares6;
  return (
    <section className={`border rounded-lg p-3 min-w-0 ${side === "UP" ? "border-up/50" : "border-down/50"}`} aria-label={`${side} leg`}>
      <div className="flex items-center justify-between gap-2 mb-3"><h3 className="text-[14px] font-bold"><SideTag side={side} /> LEG</h3><span className="text-[11px] text-muted">held <ExactValue value={held} /></span></div>
      {effects.length === 0 ? <Empty text={`No ${side} effect was dispatched.`} /> : effects.map((effect) => <Effect key={effect.id} effect={effect} />)}
      <h4 className="uppercase tracking-wide text-[10px] text-muted mt-3 mb-1">Independent outcomes / fills</h4>
      {evidence.length === 0 ? <p className="text-[11px] text-muted">No result evidence yet.</p> : evidence.map((row) => (
        <div key={row.id} className="border-l-2 border-grid pl-2 py-1 text-[11px]">
          <div className="flex flex-wrap items-center gap-2"><Status value={row.processingResult ?? row.evidenceKind ?? "RECORDED"} /><span className="font-mono text-muted">{row.evidenceKey ?? row.id}</span></div>
          {exactFields(row.payload).map(([key, value]) => <div key={key} className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-2 mt-1"><span className="text-muted">{key}</span><ExactValue value={value} /></div>)}
          <JsonEvidence value={row.payload} />
        </div>
      ))}
      <h4 className="uppercase tracking-wide text-[10px] text-muted mt-3 mb-1">Immutable inventory lots</h4>
      {lots.length === 0 ? <p className="text-[11px] text-muted">No acquired lot.</p> : lots.map((lot) => <JsonEvidence key={String(lot.id)} value={lot} />)}
    </section>
  );
}

function Effect({ effect }: { effect: PairEffectRow }) {
  return <div className="mb-2 text-[11px]"><div className="flex flex-wrap items-center gap-2"><Status value={effect.state ?? "UNKNOWN"} /><span>{effect.actionKind ?? "LEG_EFFECT"} · action {effect.actionSequence ?? "—"}.{effect.effectOrdinal ?? "—"}</span></div><div className="font-mono text-muted mt-1">effect {effect.id} · evidence {effect.resultEvidenceId ?? "pending"}</div>{effect.lastErrorCode && <div className="text-critical">{effect.lastErrorCode}</div>}<JsonEvidence value={effect.requestPayload} /></div>;
}

function ExactEvidenceTables({ group }: { group: PairGroupDetail }) {
  const consumptions = group.inventoryConsumptions ?? [];
  const ledger = group.ledgerEntries ?? [];
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      <Card title="Exact inventory consumption">
        {consumptions.length === 0 ? <Empty text="No inventory consumption recorded." /> : <div className="overflow-x-auto"><table className="w-full" tabIndex={0}><caption className="sr-only">Immutable inventory consumption rows</caption><thead><tr><th className="th">Kind</th><th className="th">Lot</th><th className="th">Shares6</th><th className="th">Principal6</th><th className="th">Fee6</th></tr></thead><tbody>{consumptions.map((row) => <tr key={String(row.id)}><td className="td">{String(row.consumptionKind ?? "—")}</td><td className="td font-mono">{String(row.lotId ?? "—")}</td><td className="td"><ExactValue value={String(row.shares6 ?? "—")} /></td><td className="td"><ExactValue value={String(row.allocatedPrincipalCost6 ?? "—")} /></td><td className="td"><ExactValue value={String(row.allocatedBuyCashFee6 ?? "—")} /></td></tr>)}</tbody></table></div>}
      </Card>
      <Card title="Double-entry ledger · exact">
        {ledger.length === 0 ? <Empty text="No ledger entries recorded." /> : <div className="overflow-x-auto"><table className="w-full" tabIndex={0}><caption className="sr-only">Exact immutable pair ledger</caption><thead><tr><th className="th">Journal / line</th><th className="th">Account</th><th className="th">Asset</th><th className="th">Amount6</th><th className="th">Event</th></tr></thead><tbody>{ledger.map((row) => <tr key={String(row.id)}><td className="td font-mono">{String(row.journalId ?? "—")} / {String(row.lineNumber ?? "—")}</td><td className="td">{String(row.account ?? "—")}</td><td className="td">{String(row.assetId ?? "—")}</td><td className="td"><ExactValue value={String(row.amount6 ?? "—")} /></td><td className="td font-mono">{String(row.eventId ?? "—")}</td></tr>)}</tbody></table></div>}
      </Card>
    </div>
  );
}

function LifecyclePanels({ group, reconciliations }: { group: PairGroupDetail; reconciliations: readonly PairReconciliation[] }) {
  const recoveryActions = (group.actions ?? []).filter((row) => String(row.actionKind ?? "").includes("RECOVERY"));
  const settlementActions = (group.actions ?? []).filter((row) => /SETTLEMENT|MERGE|RESOLUTION/.test(String(row.actionKind ?? "")));
  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
      <Card title="Residual & recovery">
        <dl className="grid grid-cols-2 gap-2 text-[11px]"><Field label="Residual"><SideTag side={group.residualSide ?? null} /> <ExactValue value={group.residualShares6} /></Field><Field label="Unrealized mark"><ExactValue value={group.unrealizedResidualMark6} /></Field><Field label="Attempts">{group.recoveryAttempts ?? 0}</Field><Field label="Deadline">{fmtTs(group.recoveryDeadlineMs)}</Field><Field label="Recovery realized P&amp;L"><ExactValue value={group.realizedRecoveryPnl6} /></Field></dl>
        {recoveryActions.length === 0 ? <p className="text-[11px] text-muted mt-3">No recovery action chosen; policy remains {group.recoveryPolicy}.</p> : recoveryActions.map((row) => <JsonEvidence key={String(row.id)} value={row} />)}
      </Card>
      <Card title="Settlement / resolution">
        <dl className="grid grid-cols-2 gap-2 text-[11px]"><Field label="Policy">{group.settlementPolicy}</Field><Field label="Settlement costs"><ExactValue value={group.settlementCosts6} /></Field><Field label="Matched shares"><ExactValue value={group.matchedShares6} /></Field><Field label="Realized pair P&amp;L"><ExactValue value={group.realizedPairPnl6} /></Field><Field label="Closed">{fmtTs(group.closedAtMs)}</Field></dl>
        {settlementActions.map((row) => <JsonEvidence key={String(row.id)} value={row} />)}
      </Card>
      <Card title="Reconciliation">
        <div className="flex items-center justify-between"><Status value={group.reconciliationStatus} /><span className="text-[11px] text-muted">last {fmtTs(group.lastReconciledAtMs)}</span></div>
        {reconciliations.length === 0 ? <Empty text="No reconciliation run recorded." /> : reconciliations.map((run) => <div key={run.id} className="mt-3 border-t border-hairline pt-2 text-[11px]"><div className="flex items-center gap-2"><Status value={run.status} /><span>{run.cause}</span><span className="ml-auto num text-muted">{fmtTs(run.startedAtMs)}</span></div>{(run.diffs ?? []).map((diff) => <div key={diff.id} className="mt-2 border-l-2 border-critical pl-2"><div className="text-critical font-semibold">{diff.severity} · {diff.code}</div><div className="grid grid-cols-2 gap-2"><JsonEvidence value={diff.expectedJson} /><JsonEvidence value={diff.actualJson} /></div></div>)}</div>)}
      </Card>
    </div>
  );
}

export function PairCausalTimeline({ events, loading = false }: { events: readonly PairGroupEvent[]; loading?: boolean }) {
  const ordered = orderedEvents(events);
  return (
    <Card title="Ordered causal timeline">
      {loading ? <Empty text="Loading ordered events…" /> : ordered.length === 0 ? <Empty text="No lifecycle events recorded." /> : (
        <ol className="relative ml-2 border-l border-hairline" aria-label="Pair group causal lifecycle">
          {ordered.map((event) => {
            const timing = timelineTiming(event);
            const evidence = evidenceReference(event);
            const deltas = exactFields(event.payload);
            return <li key={event.id} className="relative pl-5 pb-5 last:pb-0"><span className="absolute -left-1.5 top-1 w-3 h-3 rounded-full border-2 border-panel bg-up" aria-hidden /><div className="flex flex-wrap items-baseline gap-2"><span className="text-[10px] text-muted num">#{event.sequence}</span><span className="text-[10px] uppercase tracking-wide text-up">{timelineStage(event.eventType)}</span><strong className="text-[12px] text-ink">{event.eventType}</strong></div><dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-2 mt-1 text-[11px]"><Field label="Scheduled">{fmtTs(timing.scheduled)}</Field><Field label="Actual">{fmtTs(timing.actual)}</Field><Field label="Delay">{timing.delay === null ? "—" : `${timing.delay} ms`}</Field><Field label="Evidence">{evidence ?? "—"}</Field><Field label="Correlation">{event.correlationId ?? "—"}</Field>{deltas.length > 0 && <Field label="Economic delta">{deltas.map(([key, value]) => <span key={key} className="block">{key}: <ExactValue value={value} /></span>)}</Field>}</dl><JsonEvidence value={event.payload} /></li>;
          })}
        </ol>
      )}
    </Card>
  );
}

export function PairGroupDetailView({ group, events, reconciliations, eventsLoading = false, reconciliationsLoading = false }: { group: PairGroupDetail; events: readonly PairGroupEvent[]; reconciliations: readonly PairReconciliation[]; eventsLoading?: boolean; reconciliationsLoading?: boolean }) {
  return (
    <div className="space-y-4">
      <PairDetailBanners group={group} />
      <div className="flex flex-wrap items-center gap-3"><h1 className="text-xl font-semibold text-ink">Pair group <span className="font-mono">{group.id}</span></h1><Status value={group.state} /><Status value={group.reconciliationStatus} /><span className="text-[11px] text-muted ml-auto">created {fmtTs(group.createdAtMs)} · updated {fmtTs(group.updatedAtMs)}</span></div>
      <IdentityAndQuotes group={group} />
      <RiskAndReservation group={group} />
      <Card title="Both legs, independent outcomes & fills"><div className="grid grid-cols-1 md:grid-cols-2 gap-4"><LegPanel side="UP" group={group} /><LegPanel side="DOWN" group={group} /></div></Card>
      <ExactEvidenceTables group={group} />
      <LifecyclePanels group={group} reconciliations={reconciliations} />
      {reconciliationsLoading && <p role="status" className="text-[11px] text-muted">Loading reconciliation history…</p>}
      <PairCausalTimeline events={events} loading={eventsLoading} />
    </div>
  );
}

export type PairEventsResponse = PairPage<PairGroupEvent>;
export type PairReconciliationsResponse = PairPage<PairReconciliation>;

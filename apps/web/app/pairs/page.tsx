"use client";

import { Card, Empty, StateBadge, Td, Th } from "../../components/ui";
import { fmtTs, useApi } from "../../lib/hooks";
import {
  durationLabel,
  exactTone,
  formatExact6,
  formatExactInteger,
  runtimeValue,
  scenarioResults,
  sumExact,
  type PairEpisode,
  type PairGroup,
  type PairPage,
  type PairResearchRun,
  type PairSummary,
} from "../../lib/pairs";

function Exact({ value, kind = "amount", prefix = "", signed = false, className = "" }: {
  value: string | null | undefined;
  kind?: "amount" | "integer";
  prefix?: string;
  signed?: boolean;
  className?: string;
}) {
  const rendered = kind === "amount" ? formatExact6(value) : formatExactInteger(value);
  const positive = signed && value !== null && value !== undefined && /^\+?[1-9][0-9]*$/.test(value);
  return (
    <span className={`num ${className}`} title={value === null || value === undefined ? undefined : `Exact integer: ${value}`}>
      {positive ? "+" : ""}{rendered === "—" ? rendered : `${prefix}${rendered}`}
    </span>
  );
}

function HealthItem({ label, value, detail, tone = "neutral" }: {
  label: string;
  value: string;
  detail: string;
  tone?: "good" | "warning" | "critical" | "neutral";
}) {
  const color = tone === "good" ? "text-good" : tone === "critical" ? "text-critical" : tone === "warning" ? "text-warning" : "text-ink";
  const symbol = tone === "good" ? "✓" : tone === "critical" ? "✕" : tone === "warning" ? "!" : "·";
  return (
    <li className="min-w-0 px-3 py-3 border-r border-hairline last:border-r-0">
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`mt-1 text-[13px] font-semibold ${color}`}><span aria-hidden>{symbol} </span>{value}</div>
      <div className="mt-0.5 text-[10px] text-muted truncate" title={detail}>{detail}</div>
    </li>
  );
}

function TableFrame({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="overflow-x-auto focus:outline-none focus:ring-2 focus:ring-up/60 rounded" tabIndex={0} role="region" aria-label={label}>{children}</div>;
}

function PairBanner({ summary }: { summary: PairSummary | null }) {
  return (
    <section className="border border-warning/60 bg-warning/10 rounded-lg p-4" aria-label="Pair execution capability">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-warning font-bold tracking-[0.12em] text-[13px]">RESEARCH / COUNTERFACTUAL PAPER ONLY</p>
          <p className="mt-1 text-[12px] text-ink2">Complete-set pair observations and simulated paper outcomes. This area is read-only.</p>
        </div>
        <p className="border border-critical/60 bg-critical/10 text-critical rounded px-3 py-1.5 text-[12px] font-bold">LIVE EXECUTION DOES NOT EXIST</p>
      </div>
      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[11px]">
        <div><dt className="inline text-muted">Observer </dt><dd className="inline text-ink font-semibold">{summary ? (summary.capability.observerEnabled ? "ENABLED" : "DISABLED") : "—"}</dd></div>
        <div><dt className="inline text-muted">Paper execution </dt><dd className="inline text-ink font-semibold">{summary ? (summary.capability.paperExecutionEnabled ? "ENABLED" : "DISABLED") : "—"}</dd></div>
        <div><dt className="inline text-muted">Strategy </dt><dd className="inline text-ink font-mono">{summary?.capability.strategyVersion ?? "—"}</dd></div>
      </dl>
    </section>
  );
}

function HealthStrip({ summary, latestReplayAtMs }: { summary: PairSummary; latestReplayAtMs: number | null }) {
  const { health } = summary;
  const runtime = health.runtime;
  const feedHealthy = runtimeValue(runtime, "sources", "observerEvaluationHealthy") ?? runtimeValue(runtime, "observerEvaluationHealthy");
  const queueDepth = runtimeValue(runtime, "queue", "depth") ?? runtimeValue(runtime, "captureQueueDepth");
  const queueCapacity = runtimeValue(runtime, "queue", "capacity") ?? runtimeValue(runtime, "captureQueueCapacity");
  const feeHealthy = runtimeValue(runtime, "sources", "feeTermsHealthy") ?? runtimeValue(runtime, "feeTermsHealthy");
  const constraintHealthy = runtimeValue(runtime, "sources", "constraintTermsHealthy") ?? runtimeValue(runtime, "constraintTermsHealthy");
  const termsKnown = typeof feeHealthy === "boolean" && typeof constraintHealthy === "boolean";
  const termsGood = feeHealthy === true && constraintHealthy === true;
  const mismatchCount = health.pairAccountMismatchCount + health.groupMismatchCount;
  const criticalCount = mismatchCount + health.unknownOutcomeGroupCount + health.manualReviewGroupCount;
  return (
    <section aria-labelledby="pair-health-title">
      <div className="flex items-center justify-between mb-2">
        <h2 id="pair-health-title" className="text-[12px] uppercase tracking-wider text-muted">Health strip</h2>
        <StateBadge state={health.status} />
      </div>
      <ul className="panel grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 overflow-hidden">
        <HealthItem label="Feed integrity" value={typeof feedHealthy === "boolean" ? (feedHealthy ? "Healthy" : "Degraded") : "Not reported"} detail="paired-book evaluator" tone={feedHealthy === true ? "good" : feedHealthy === false ? "critical" : "neutral"} />
        <HealthItem label="Capture queue" value={queueDepth === undefined ? "Not reported" : `${String(queueDepth)} / ${String(queueCapacity ?? "?")}`} detail={`${health.pendingEffectCount} pending durable effects`} tone={health.pendingEffectCount > 0 ? "warning" : queueDepth === undefined ? "neutral" : "good"} />
        <HealthItem label="Fee + constraints" value={termsKnown ? (termsGood ? "Fresh" : "Stale") : "Not reported"} detail="both terms must be current" tone={termsKnown ? (termsGood ? "good" : "critical") : "neutral"} />
        <HealthItem label="Pair ledger" value={mismatchCount === 0 ? "Reconciled" : `${mismatchCount} mismatch${mismatchCount === 1 ? "" : "es"}`} detail={`last ${fmtTs(health.lastReconciledAtMs)}`} tone={mismatchCount === 0 ? "good" : "critical"} />
        <HealthItem label="Last replay" value={latestReplayAtMs === null ? "No completed run" : fmtTs(latestReplayAtMs)} detail="offline research run" tone={latestReplayAtMs === null ? "neutral" : "good"} />
        <HealthItem label="Critical counts" value={String(criticalCount)} detail={`${health.unknownOutcomeGroupCount} unknown · ${health.manualReviewGroupCount} review`} tone={criticalCount > 0 ? "critical" : "good"} />
      </ul>
    </section>
  );
}

function Funnel({ summary }: { summary: PairSummary }) {
  const stages: Array<{ label: string; value: string | null; note?: string }> = [
    { label: "Evaluated", value: summary.trailing24h.evaluatedEnvelopes },
    { label: "Prefilter", value: null, note: "not exposed" },
    { label: "Gross", value: summary.trailing24h.grossDislocations },
    { label: "Fee-positive", value: summary.trailing24h.feePositiveObservations },
    { label: "Stress-positive", value: null, note: "not exposed" },
    { label: "Activation-survived", value: String(summary.trailing24h.activationSurvivors) },
    { label: "Paired", value: String(summary.trailing24h.pairedGroups) },
  ];
  return (
    <Card title="Opportunity funnel · trailing 24h" className="xl:col-span-2">
      <ol className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-7 gap-px bg-grid border border-grid rounded overflow-hidden" aria-label="Opportunity funnel stages">
        {stages.map((stage, index) => (
          <li key={stage.label} className="bg-panel2 px-3 py-3 min-w-0">
            <div className="text-[10px] text-muted">{index + 1}. {stage.label}</div>
            <div className="text-xl text-ink font-semibold mt-1"><Exact value={stage.value} kind="integer" /></div>
            {stage.note && <div className="text-[10px] text-muted mt-1">{stage.note}</div>}
          </li>
        ))}
      </ol>
      <p className="mt-3 text-[11px] text-muted">A missing stage is shown as unavailable; it is never inferred from neighboring counts.</p>
    </Card>
  );
}

function Exposure({ summary, groups }: { summary: PairSummary; groups: PairGroup[] }) {
  const loadedActive = groups.filter((group) => group.state !== "RECONCILED_FLAT" && group.state !== "RECONCILED_SETTLED");
  const upResidual = sumExact(loadedActive.filter((group) => group.residualSide === "UP").map((group) => group.residualShares6));
  const downResidual = sumExact(loadedActive.filter((group) => group.residualSide === "DOWN").map((group) => group.residualShares6));
  const worstCase = sumExact(loadedActive.map((group) => group.currentWorstCaseLoss6));
  return (
    <Card title="Current paper exposure">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        <div><dt className="text-[10px] uppercase text-muted">Cash available</dt><dd className="text-lg text-ink"><Exact value={summary.current.pairCashAvailable6} prefix="$" /></dd></div>
        <div><dt className="text-[10px] uppercase text-muted">Reserved</dt><dd className="text-lg text-warning"><Exact value={summary.current.pairCashReserved6} prefix="$" /></dd></div>
        <div><dt className="text-[10px] uppercase text-muted">UP residual</dt><dd className="text-base text-up"><Exact value={upResidual} /></dd></div>
        <div><dt className="text-[10px] uppercase text-muted">DOWN residual</dt><dd className="text-base text-down"><Exact value={downResidual} /></dd></div>
        <div><dt className="text-[10px] uppercase text-muted">Worst-case loss</dt><dd className="text-base text-warning"><Exact value={worstCase} prefix="$" /></dd></div>
        <div><dt className="text-[10px] uppercase text-muted">Active groups</dt><dd className="text-base text-ink num">{summary.current.activeGroups}</dd></div>
        <div><dt className="text-[10px] uppercase text-muted">Unknown outcomes</dt><dd className={summary.current.unknownOutcomeGroups > 0 ? "text-critical font-semibold num" : "text-ink num"}>{summary.current.unknownOutcomeGroups}</dd></div>
        <div><dt className="text-[10px] uppercase text-muted">Manual review</dt><dd className={summary.current.manualReviewGroups > 0 ? "text-critical font-semibold num" : "text-ink num"}>{summary.current.manualReviewGroups}</dd></div>
      </dl>
      <p className="mt-3 text-[10px] text-muted">Residual and worst-case totals cover the newest loaded groups; authoritative account reservation is shown above.</p>
    </Card>
  );
}

function EpisodesTable({ episodes }: { episodes: PairEpisode[] }) {
  return (
    <Card title="Recent opportunity episodes">
      {episodes.length === 0 ? <Empty text="No pair opportunity episodes have been recorded." /> : (
        <TableFrame label="Recent opportunity episodes table">
          <table className="w-full min-w-[1040px]">
            <caption className="sr-only">Recent complete-set pair opportunity episodes</caption>
            <thead><tr><Th>Episode / market</Th><Th>State</Th><Th>Duration</Th><Th>Best ask sum</Th><Th>Best net quoted</Th><Th>Activation quote</Th><Th>Envelopes</Th><Th>Activation</Th><Th>Close reason</Th></tr></thead>
            <tbody>{episodes.map((episode) => (
              <tr key={episode.id}>
                <Td><div className="font-mono text-[11px] text-ink">{episode.id}</div><div className="font-mono text-[10px] text-muted">{episode.marketId}</div></Td>
                <Td><StateBadge state={episode.state} /></Td>
                <Td className="num">{durationLabel(episode.firstObservedAtMs, episode.closedAtMs ?? episode.lastObservedAtMs)}</Td>
                <Td className="text-ink"><Exact value={episode.minimumAskSum6} /></Td>
                <Td className={exactTone(episode.maximumSignalNetPnl6) === "good" ? "text-good" : exactTone(episode.maximumSignalNetPnl6) === "critical" ? "text-critical" : "text-ink"}><Exact value={episode.maximumSignalNetPnl6} prefix="$" signed /></Td>
                <Td className={exactTone(episode.maximumActivationNetPnl6) === "good" ? "text-good" : exactTone(episode.maximumActivationNetPnl6) === "critical" ? "text-critical" : "text-ink"}><Exact value={episode.maximumActivationNetPnl6} prefix="$" signed /></Td>
                <Td><Exact value={episode.eligibleEnvelopeCount} kind="integer" /> / <Exact value={episode.envelopeCount} kind="integer" /></Td>
                <Td>{episode.maximumActivationNetPnl6 !== null && episode.maximumActivationNetPnl6 !== undefined ? <span className="text-good">✓ Survived</span> : episode.scheduledGroupCount > 0 ? <span className="text-warning">! Scheduled</span> : <span className="text-muted">Not reached</span>}</Td>
                <Td>{episode.closeReason ?? (episode.state === "OPEN" ? "Still open" : "—")}</Td>
              </tr>
            ))}</tbody>
          </table>
        </TableFrame>
      )}
    </Card>
  );
}

function GroupsTable({ groups }: { groups: PairGroup[] }) {
  return (
    <Card title="Recent paper groups">
      {groups.length === 0 ? <Empty text="No counterfactual paper groups have been scheduled." /> : (
        <TableFrame label="Recent paper groups table">
          <table className="w-full min-w-[1280px]">
            <caption className="sr-only">Recent complete-set pair paper groups with separate UP and DOWN legs</caption>
            <thead><tr><Th>Group / market</Th><Th>State</Th><Th>Dispatch</Th><Th>UP held</Th><Th>DOWN held</Th><Th>Matched</Th><Th>Residual</Th><Th>Prospective quote P&amp;L</Th><Th>Activation quote P&amp;L</Th><Th>Realized P&amp;L</Th><Th>Reconciliation</Th></tr></thead>
            <tbody>{groups.map((group) => (
              <tr key={group.id}>
                <Td><div className="font-mono text-[11px] text-ink">{group.id}</div><div className="font-mono text-[10px] text-muted">{group.marketId}</div></Td>
                <Td><StateBadge state={group.state} /></Td>
                <Td><div>{group.dispatchModel}</div><div className="text-[10px] text-muted">{group.recoveryPolicy}</div></Td>
                <Td className="text-up"><span className="sr-only">UP </span><Exact value={group.upHeldShares6} /></Td>
                <Td className="text-down"><span className="sr-only">DOWN </span><Exact value={group.downHeldShares6} /></Td>
                <Td><Exact value={group.matchedShares6} /></Td>
                <Td>{group.residualSide ? <span className="text-warning"><span className={group.residualSide === "UP" ? "text-up" : "text-down"}>{group.residualSide}</span> <Exact value={group.residualShares6} /></span> : <span className="text-muted">None</span>}</Td>
                <Td className={exactTone(group.signalNetPnl6) === "good" ? "text-ink" : exactTone(group.signalNetPnl6) === "critical" ? "text-critical" : "text-ink"}><Exact value={group.signalNetPnl6} prefix="$" signed /></Td>
                <Td className={exactTone(group.activationNetPnl6) === "critical" ? "text-critical" : "text-ink"}><Exact value={group.activationNetPnl6} prefix="$" signed /></Td>
                <Td className={exactTone(group.realizedPairPnl6) === "good" ? "text-good" : exactTone(group.realizedPairPnl6) === "critical" ? "text-critical" : "text-ink"}><Exact value={group.realizedPairPnl6} prefix="$" signed /></Td>
                <Td><StateBadge state={group.reconciliationStatus} /></Td>
              </tr>
            ))}</tbody>
          </table>
        </TableFrame>
      )}
      <p className="mt-3 text-[10px] text-muted">Positive prospective and activation quotes remain neutral; only reconciled, ledger-derived realized gains use green.</p>
    </Card>
  );
}

function ResearchResults({ runs }: { runs: PairResearchRun[] }) {
  const latest = runs.find((run) => run.status === "SUCCEEDED" && run.summaryJson !== null && run.summaryJson !== undefined) ?? null;
  const scenarios = scenarioResults(latest?.summaryJson);
  return (
    <Card title="Research results · latency / dispatch / depth">
      {runs.length === 0 ? <Empty text="No offline research runs have completed." /> : (
        <div className="space-y-4">
          <TableFrame label="Research run summaries table">
            <table className="w-full min-w-[760px]">
              <caption className="sr-only">Offline pair research run summaries</caption>
              <thead><tr><Th>Run</Th><Th>Status</Th><Th>Strategy</Th><Th>Markets</Th><Th>Events</Th><Th>Episodes</Th><Th>Promotion verdict</Th><Th>Completed</Th></tr></thead>
              <tbody>{runs.map((run) => <tr key={run.id}>
                <Td className="font-mono text-[11px] text-ink">{run.id}</Td><Td><StateBadge state={run.status} /></Td><Td className="font-mono text-[11px]">{run.strategyVersion}</Td><Td className="num">{run.marketCount}</Td><Td><Exact value={run.eventCount} kind="integer" /></Td><Td className="num">{run.episodeCount}</Td><Td>{run.promotionVerdict ?? "Not evaluated"}</Td><Td className="num">{fmtTs(run.completedAtMs)}</Td>
              </tr>)}</tbody>
            </table>
          </TableFrame>
          <div>
            <h3 className="text-[11px] uppercase tracking-wider text-muted mb-2">Latest successful scenario comparison</h3>
            {scenarios.length === 0 ? <Empty text="The latest run has no overview-compatible scenario summary." /> : (
              <TableFrame label="Latest research scenario comparison table">
                <table className="w-full min-w-[820px]">
                  <caption className="sr-only">Latency, dispatch, and depth scenario estimates with sample counts and confidence intervals</caption>
                  <thead><tr><Th>Scenario</Th><Th>Latency</Th><Th>Dispatch</Th><Th>Depth</Th><Th>Samples</Th><Th>Estimated net P&amp;L</Th><Th>Confidence interval</Th></tr></thead>
                  <tbody>{scenarios.map((scenario) => <tr key={`${scenario.label}-${scenario.latency}-${scenario.dispatch}-${scenario.depth}`}>
                    <Td className="text-ink">{scenario.label}</Td><Td>{scenario.latency}</Td><Td>{scenario.dispatch}</Td><Td>{scenario.depth}</Td><Td><Exact value={scenario.sampleCount} kind="integer" /></Td><Td><Exact value={scenario.estimate6} prefix="$" signed /></Td><Td><Exact value={scenario.confidenceLow6} prefix="$" signed /> <span className="text-muted">to</span> <Exact value={scenario.confidenceHigh6} prefix="$" signed /></Td>
                  </tr>)}</tbody>
                </table>
              </TableFrame>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

export default function PairsPage() {
  const summary = useApi<PairSummary>("/api/pairs/summary");
  const episodes = useApi<PairPage<PairEpisode>>("/api/pairs/episodes?limit=12");
  const groups = useApi<PairPage<PairGroup>>("/api/pairs/groups?limit=12");
  const runs = useApi<PairPage<PairResearchRun>>("/api/pairs/research-runs?limit=8");
  const failures = [
    ["summary", summary.error], ["episodes", episodes.error], ["groups", groups.error], ["research runs", runs.error],
  ].filter((item): item is [string, string] => item[1] !== null);
  const initialLoading = summary.data === null && episodes.data === null && groups.data === null && runs.data === null && failures.length === 0;
  const latestReplayAtMs = runs.data?.items.reduce<number | null>((latest, run) => {
    if (run.completedAtMs === null || run.completedAtMs === undefined) return latest;
    return latest === null || run.completedAtMs > latest ? run.completedAtMs : latest;
  }, null) ?? null;

  return (
    <div className="space-y-4">
      <PairBanner summary={summary.data} />
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div><h1 className="text-xl font-semibold text-ink">Complete-set pair research</h1><p className="text-[12px] text-muted mt-1">Read-only evidence, counterfactual paper execution, exposure, and replay results.</p></div>
        {summary.data && <div className="text-[11px] text-muted">24h realized <Exact value={summary.data.trailing24h.realizedPnl6} prefix="$" signed className={exactTone(summary.data.trailing24h.realizedPnl6) === "good" ? "text-good" : exactTone(summary.data.trailing24h.realizedPnl6) === "critical" ? "text-critical" : "text-ink"} /></div>}
      </div>

      {summary.data && (summary.data.current.residualGroups > 0 || summary.data.current.manualReviewGroups > 0 || summary.data.current.unknownOutcomeGroups > 0) && (
        <div className="border border-critical/50 bg-critical/10 rounded px-4 py-3 text-[12px] text-critical" role="alert">
          <strong>Operator attention:</strong> {summary.data.current.residualGroups} residual, {summary.data.current.unknownOutcomeGroups} unknown-outcome, and {summary.data.current.manualReviewGroups} manual-review paper group(s). No live action is available here.
        </div>
      )}

      {initialLoading && <div className="panel p-8 text-center text-[13px] text-muted" role="status" aria-live="polite">Loading pair research read models…</div>}
      {failures.length > 0 && (
        <div className="border border-critical/60 bg-critical/10 rounded p-4" role="alert">
          <p className="font-semibold text-critical">Some pair research data could not be loaded.</p>
          <ul className="mt-2 list-disc list-inside text-[12px] text-ink2">{failures.map(([name, error]) => <li key={name}><span className="text-ink">{name}:</span> {error}</li>)}</ul>
          <p className="mt-2 text-[11px] text-muted">This read-only page will update on the next navigation or refresh; no execution state was changed.</p>
        </div>
      )}

      {summary.data && <HealthStrip summary={summary.data} latestReplayAtMs={latestReplayAtMs} />}
      {summary.data && <div className="grid grid-cols-1 xl:grid-cols-3 gap-4"><Funnel summary={summary.data} /><Exposure summary={summary.data} groups={groups.data?.items ?? []} /></div>}
      {episodes.data && <EpisodesTable episodes={episodes.data.items} />}
      {groups.data && <GroupsTable groups={groups.data.items} />}
      {runs.data && <ResearchResults runs={runs.data.items} />}
    </div>
  );
}

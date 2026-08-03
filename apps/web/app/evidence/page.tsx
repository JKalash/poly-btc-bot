"use client";

import { useMemo, useState } from "react";
import { Card, Empty, Th, Td } from "../../components/ui";
import { fmtTs, useApi } from "../../lib/hooks";
import { pct, shortId } from "../../lib/execution";
import {
  countPairs, EVIDENCE_LABELS, nfmt, HYPOTHESIS_STATUS_CLS, LABEL_COUNT_TONE, LABEL_META,
  type EvidenceLabel, type ExperimentRow, type ExperimentRunRow, type ExperimentsPayload,
  type LedgerClaim, type LedgerPayload, type ManifestRow, type ManifestsPayload,
} from "../../lib/evidence";

const LEDGER_EMPTY =
  "No source claims recorded yet — rows arrive from seed-evidence and the R1–R8/R11 reproduction runners.";
const EXPERIMENTS_EMPTY =
  "No experiments registered yet — definitions appear when a reproduction runner preregisters its hypothesis, null, and decision rule before running.";
const MANIFESTS_EMPTY =
  "No dataset manifests recorded yet — every experiment consumes immutable, checksummed dataset snapshots described here.";

const checksum8 = (v: string | null): string => (v ? `${v.slice(0, 8)}…` : "—");

function LabelBadge({ label, wrap = false }: { label: EvidenceLabel; wrap?: boolean }) {
  const meta = LABEL_META[label] ?? { cls: "bg-panel2 text-ink2 border-hairline", caption: label };
  return (
    <span
      title={meta.caption}
      className={`inline-flex items-center border rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${wrap ? "max-w-full whitespace-normal break-all leading-tight" : "whitespace-nowrap"} ${meta.cls}`}
    >
      {label}
    </span>
  );
}

function HypothesisBadge({ status }: { status: string }) {
  const cls = HYPOTHESIS_STATUS_CLS[status] ?? "bg-panel2 text-ink2 border-hairline";
  return (
    <span className={`inline-flex items-center border rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide whitespace-nowrap ${cls}`}>
      {status}
    </span>
  );
}

function MaterializedBadge({ materialized }: { materialized: boolean }) {
  return materialized ? (
    <span className="inline-flex items-center border rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide bg-good/15 text-good border-good/40">
      MATERIALIZED
    </span>
  ) : (
    <span className="inline-flex items-center border rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide bg-warning/15 text-warning border-warning/50">
      NOT MATERIALIZED — DATA GATED
    </span>
  );
}

/** Two thin single-hue bars, baseline-anchored, direct-labeled in ink tokens. */
function PairBars({ claimed, reproduced }: { claimed: number; reproduced: number }) {
  const max = Math.max(Math.abs(claimed), Math.abs(reproduced), 1);
  const rows: Array<[string, number, string]> = [
    ["claimed", claimed, "bg-up/45"],
    ["reproduced", reproduced, "bg-up"],
  ];
  return (
    <div className="space-y-1">
      {rows.map(([label, value, barCls]) => (
        <div key={label} className="flex items-center gap-3 min-h-[16px]" title={`${label}: ${nfmt(value)}`}>
          <div className="w-20 shrink-0 text-[10px] uppercase tracking-wider text-muted text-right">{label}</div>
          <div className="flex-1 relative h-[10px]" aria-hidden>
            <div
              className={`absolute inset-y-0 left-0 rounded-r-[4px] ${barCls}`}
              style={{ width: `max(2px, ${(Math.abs(value) / max) * 100}%)` }}
            />
          </div>
          <div className="w-24 shrink-0 num text-[12px] text-ink text-right">{nfmt(value)}</div>
        </div>
      ))}
    </div>
  );
}

export default function EvidenceLabPage() {
  const ledger = useApi<LedgerPayload>("/api/evidence/ledger", 30_000);
  const experiments = useApi<ExperimentsPayload>("/api/evidence/experiments", 30_000);
  const manifests = useApi<ManifestsPayload>("/api/evidence/manifests", 30_000);

  const claims = ledger.data?.claims ?? [];
  const counts = ledger.data?.counts ?? {};
  const totalClaims = claims.length;

  const compared = useMemo(
    () => claims.filter((c) => c.reproducedValue !== null || c.label === "DATA_GATED"),
    [claims],
  );
  const reconciliation = useMemo(
    () =>
      claims.flatMap((c) => {
        const pairs = countPairs(c.claimedValue, c.reproducedValue);
        return pairs.length > 0 ? [{ claim: c, pairs }] : [];
      }),
    [claims],
  );

  return (
    <div className="space-y-4">
      <div className="border border-serious/40 bg-serious/10 rounded-lg px-4 py-3 text-serious text-[13px] font-semibold">
        ⚠ A failed reproduction is a result — REPRODUCED_MISMATCH and DATA_GATED carry the same standing as a match.
        A claim's label moves up only through a recorded reproduction or live measurement, never by assertion.
      </div>
      {(ledger.data?.note || experiments.data?.note || manifests.data?.note) && (
        <p className="text-[12px] text-warning">
          {ledger.data?.note ?? experiments.data?.note ?? manifests.data?.note}
        </p>
      )}

      {/* Epistemic census: every label in the vocabulary, zero or not — equal weight */}
      <div className="panel grid grid-cols-4 xl:grid-cols-8 divide-x divide-hairline">
        {EVIDENCE_LABELS.map((label) => (
          <div key={label} className="px-3 py-3 min-w-0" title={LABEL_META[label].caption}>
            <div className={`text-xl font-semibold num ${LABEL_COUNT_TONE[label]}`}>
              {ledger.data ? counts[label] ?? 0 : "—"}
            </div>
            <div className="mt-1"><LabelBadge label={label} wrap /></div>
          </div>
        ))}
      </div>

      {/* Source ledger */}
      <Card title={`Source ledger · ${totalClaims} claim${totalClaims === 1 ? "" : "s"} with provenance`}>
        {claims.length === 0 ? <Empty text={LEDGER_EMPTY} /> : <LedgerTable claims={claims} />}
        <p className="text-[11px] text-muted mt-3">
          {(ledger.data?.notes ?? []).join(" ")} SOURCE_CLAIM_UNVERIFIED means exactly that: source claim — not
          reproduced. Click a row for the full claim text, methodology notes and dataset provenance.
        </p>
      </Card>

      <div className="grid grid-cols-2 gap-4">
        {/* Claimed vs reproduced */}
        <Card title="Claimed vs reproduced · methodology differences stay attached">
          {compared.length === 0 ? (
            <Empty text="No reproductions recorded yet. The reproduction runners write claimed-vs-reproduced pairs here — a failed reproduction is a result, and it will be shown exactly like a success." />
          ) : (
            <div className="space-y-3">
              {compared.map((c) => (
                <div key={c.id} className="border border-hairline rounded-lg px-4 py-3">
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <span className="text-[13px] font-semibold text-ink truncate" title={c.title}>{c.title}</span>
                    <LabelBadge label={c.label} />
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-[12px]">
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-muted mb-0.5">Claimed{c.units ? ` (${c.units})` : ""}</div>
                      <div className="font-mono text-ink2 break-words">{c.claimedValue ?? "—"}</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-muted mb-0.5">Reproduced</div>
                      {c.reproducedValue !== null ? (
                        <div className="font-mono text-ink break-words">{c.reproducedValue}</div>
                      ) : (
                        <div className="text-warning">— dataset not materialized; reproduction awaits data, never faked</div>
                      )}
                    </div>
                  </div>
                  <p className="text-[11px] text-muted mt-2">
                    {c.methodologyNotes ? `Methodology diff — ${c.methodologyNotes}` : "No methodology differences recorded."}
                  </p>
                </div>
              ))}
            </div>
          )}
          <p className="text-[11px] text-muted mt-3">
            The maker-fill toxicity claim above is why execution telemetry exists: being filled can be adverse
            information.
          </p>
        </Card>

        {/* Sample-count reconciliation */}
        <Card title="Sample-count reconciliation · every denominator accounted for">
          {reconciliation.length === 0 ? (
            <Empty text="No reproduced counts yet. The favored-side reproduction (R3) must reconcile the source's 4,569 claimed decisions against its displayed band sum of 4,442 — the 127 missing decisions get explained here (excluded prices, missing books, boundary conventions, or reporting error), never hidden." />
          ) : (
            <div className="space-y-4">
              {reconciliation.map(({ claim, pairs }) =>
                pairs.map((p, i) => (
                  <div key={`${claim.id}-${i}`}>
                    <div className="flex items-center justify-between gap-3 mb-1.5">
                      <span className="text-[12px] font-semibold text-ink truncate" title={claim.title}>
                        {claim.title}{pairs.length > 1 ? ` · pair ${i + 1}` : ""}
                      </span>
                      {p.gap === 0 ? (
                        <span className="text-[11px] font-semibold text-good whitespace-nowrap">reconciled · gap 0</span>
                      ) : (
                        <span className="text-[11px] font-semibold text-serious whitespace-nowrap">
                          gap {p.gap > 0 ? "+" : ""}{nfmt(p.gap)} — must be accounted for
                        </span>
                      )}
                    </div>
                    <PairBars claimed={p.claimed} reproduced={p.reproduced} />
                    {p.gap !== 0 && claim.methodologyNotes && (
                      <p className="text-[11px] text-muted mt-1.5">Accounting — {claim.methodologyNotes}</p>
                    )}
                  </div>
                )),
              )}
            </div>
          )}
          <p className="text-[11px] text-muted mt-3">
            Outcome and fill denominators are explicit; a count gap is a finding until its exclusions are itemized.
          </p>
        </Card>
      </div>

      {/* Experiment registry */}
      <Card title="Experiment registry · preregistered hypotheses and reproduction runs">
        {(experiments.data?.experiments ?? []).length === 0 ? (
          <Empty text={EXPERIMENTS_EMPTY} />
        ) : (
          <div className="space-y-4">
            {experiments.data!.experiments.map((e) => <ExperimentBlock key={e.id} experiment={e} />)}
          </div>
        )}
        <p className="text-[11px] text-muted mt-3">
          The hypothesis, null, primary metric and decision rule are written down before any run — score strength is
          not probability, and only a preregistered walk-forward result can move a claim's label.
        </p>
      </Card>

      {/* Dataset manifests */}
      <Card title="Dataset manifests · immutable snapshots, checksummed or honestly absent">
        {(manifests.data?.manifests ?? []).length === 0 ? (
          <Empty text={MANIFESTS_EMPTY} />
        ) : (
          <ManifestTable manifests={manifests.data!.manifests} />
        )}
        <p className="text-[11px] text-muted mt-3">
          Two manifests with the same content checksum describe byte-identical data. A file without a sha256 is not on
          this machine — the experiments that need it stay DATA_GATED. No trade is a valid decision, and no run without
          its data is a valid run.
        </p>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

function LedgerTable({ claims }: { claims: LedgerClaim[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr>
            <Th>Source</Th><Th>Claim</Th><Th>Label</Th><Th>Claimed</Th><Th>Reproduced</Th>
            <Th>Retrieved · Verified</Th><Th>Run</Th>
          </tr>
        </thead>
        <tbody>
          {claims.map((c) => (
            <ClaimRows key={c.id} claim={c} open={openId === c.id} onToggle={() => setOpenId(openId === c.id ? null : c.id)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ClaimRows({ claim: c, open, onToggle }: { claim: LedgerClaim; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr onClick={onToggle} className={`cursor-pointer hover:bg-panel2 ${open ? "bg-panel2" : ""}`}>
        <Td className="font-mono text-[12px] text-ink2 whitespace-nowrap">{c.sourceKey}</Td>
        <Td className="text-ink max-w-[20rem]">
          <span className="block truncate" title={c.title}>{c.title}</span>
        </Td>
        <Td><LabelBadge label={c.label} /></Td>
        <Td className="num max-w-[11rem]">
          <span className="block truncate" title={c.claimedValue ?? undefined}>{c.claimedValue ?? "—"}</span>
        </Td>
        <Td className="num max-w-[11rem]">
          {c.reproducedValue !== null ? (
            <span className="block truncate text-ink" title={c.reproducedValue}>{c.reproducedValue}</span>
          ) : c.label === "DATA_GATED" ? (
            <span className="text-warning">gated — awaiting data</span>
          ) : (
            <span className="text-muted" title="Source claim — not reproduced.">not reproduced</span>
          )}
        </Td>
        <Td className="num text-muted whitespace-nowrap">
          <span className="block text-[11px]" title={`retrieved from the source: ${fmtTs(c.retrievedAtMs)}`}>{fmtTs(c.retrievedAtMs).slice(0, 10)}</span>
          <span className="block text-[11px]" title={`last verification / label change: ${fmtTs(c.updatedAtMs)}`}>{fmtTs(c.updatedAtMs).slice(0, 10)}</span>
        </Td>
        <Td className="num">
          {c.reproduction ? (
            <a
              href={`#run-${c.reproduction.runId}`}
              onClick={(e) => e.stopPropagation()}
              className="text-up hover:underline whitespace-nowrap"
              title={c.reproduction.experimentTitle ?? c.reproduction.runKey}
            >
              {shortId(c.reproduction.runId)}
            </a>
          ) : (
            "—"
          )}
        </Td>
      </tr>
      {open && (
        <tr className="bg-panel2/50">
          <td colSpan={7} className="px-4 py-3 border-b border-grid">
            <div className="grid grid-cols-2 gap-4 text-[12px]">
              <div className="space-y-2">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted mb-0.5">Claim as stated</div>
                  <blockquote className="border-l-2 border-hairline pl-3 text-ink2">{c.claimText}</blockquote>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted mb-0.5">Methodology notes</div>
                  <p className="text-ink2">{c.methodologyNotes ?? "None recorded."}</p>
                </div>
                {c.url && (
                  <a href={c.url} target="_blank" rel="noreferrer" className="text-up hover:underline break-all">{c.url}</a>
                )}
              </div>
              <div className="space-y-2">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted mb-0.5">Reproduction run</div>
                  {c.reproduction ? (
                    <div className="num text-ink2">
                      <a href={`#run-${c.reproduction.runId}`} className="text-up hover:underline">{c.reproduction.runKey}</a>
                      {" · "}{c.reproduction.status}
                      {" · finished "}{fmtTs(c.reproduction.finishedAtMs)}
                      {" · result "}<span className="font-mono" title={c.reproduction.resultChecksum ?? undefined}>{checksum8(c.reproduction.resultChecksum)}</span>
                      {" · code "}<span className="font-mono" title={c.reproduction.codeVersion}>{checksum8(c.reproduction.codeVersion)}</span>
                      {c.reproduction.dataGated && <span className="text-warning"> · DATA GATED</span>}
                    </div>
                  ) : (
                    <p className="text-muted">
                      {c.label === "DATA_GATED"
                        ? "Harness exists; dataset does not. Awaiting data — never faked."
                        : "No reproduction run linked. Source claim — not reproduced."}
                    </p>
                  )}
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted mb-0.5">Datasets consumed</div>
                  {c.datasets.length === 0 ? (
                    <p className="text-muted">None linked.</p>
                  ) : (
                    <ul className="space-y-1">
                      {c.datasets.map((d) => (
                        <li key={d.id} className="flex items-center gap-2">
                          <span className="font-mono text-ink2">{d.datasetKey}</span>
                          <MaterializedBadge materialized={d.materialized} />
                          <span className="font-mono text-muted" title={d.contentChecksum}>{checksum8(d.contentChecksum)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="num text-muted">
                  retrieved {fmtTs(c.retrievedAtMs)} · verified {fmtTs(c.updatedAtMs)}
                </div>
                {c.units && <div className="text-muted">Units: <span className="text-ink2">{c.units}</span></div>}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function ExperimentBlock({ experiment: e }: { experiment: ExperimentRow }) {
  return (
    <div id={`exp-${e.id}`} className="border border-hairline rounded-lg scroll-mt-20">
      <div className="px-4 py-2.5 border-b border-hairline flex items-center gap-3 flex-wrap">
        <span className="font-mono text-[12px] text-muted">{e.experimentKey}</span>
        <span className="text-[13px] font-semibold text-ink">{e.title}</span>
        <span className="ml-auto flex items-center gap-2">
          {e.dataGated && <LabelBadge label="DATA_GATED" />}
          <HypothesisBadge status={e.status} />
        </span>
      </div>
      <div className="px-4 py-3 grid grid-cols-2 gap-x-6 gap-y-2 text-[12px]">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted mb-0.5">Hypothesis (preregistered)</div>
          <p className="text-ink2">{e.hypothesis}</p>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted mb-0.5">Null hypothesis</div>
          <p className="text-ink2">{e.nullHypothesis}</p>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted mb-0.5">Primary metric · decision rule</div>
          <p><span className="font-mono text-ink">{e.primaryMetric}</span> <span className="text-muted">— {e.successCriteria}</span></p>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted mb-0.5">Fold plan · datasets</div>
          <p className="num text-ink2">
            {e.foldPlan ? foldPlanText(e.foldPlan) : "no fold plan (descriptive study)"}
            {" · "}
            <span className="font-mono">{e.datasetKeys.join(", ") || "no datasets declared"}</span>
          </p>
        </div>
      </div>
      {e.dataGated && (
        <p className="px-4 pb-2 text-[11px] text-warning">
          DATA_GATED — a required dataset is not materialized on this machine; the reproduction awaits data, never faked.
        </p>
      )}
      <div className="px-4 pb-3 space-y-2">
        {e.runs.length === 0 ? (
          <p className="text-[12px] text-muted border-t border-hairline pt-2.5">
            No runs recorded yet. A run that never happens because its data is missing is recorded as gated — a failed
            reproduction is a result, and so is an untestable one.
          </p>
        ) : (
          e.runs.map((r) => <RunBlock key={r.id} run={r} />)
        )}
      </div>
    </div>
  );
}

function foldPlanText(fp: Record<string, unknown>): string {
  const known: string[] = [];
  if (typeof fp.nFolds === "number") known.push(`${fp.nFolds} folds`);
  if (typeof fp.purge === "boolean") known.push(fp.purge ? "purged" : "NOT purged");
  if (typeof fp.embargoMs === "number") known.push(`embargo ${fp.embargoMs}ms`);
  if (typeof fp.minTrainSamples === "number") known.push(`min train ${fp.minTrainSamples}`);
  return known.length > 0 ? known.join(" · ") : JSON.stringify(fp);
}

function RunBlock({ run: r }: { run: ExperimentRunRow }) {
  return (
    <div id={`run-${r.id}`} className="border border-grid rounded-lg scroll-mt-20">
      <div className="px-3 py-2 flex items-center gap-3 flex-wrap text-[12px]">
        <span className="font-mono text-ink">{r.runKey}</span>
        <span className={`font-semibold ${r.status === "COMPLETED" ? "text-good" : r.status === "FAILED" ? "text-critical" : "text-ink2"}`}>{r.status}</span>
        {r.dataGated && <LabelBadge label="DATA_GATED" />}
        <span className="num text-muted ml-auto">
          {fmtTs(r.startedAtMs)} → {fmtTs(r.finishedAtMs)}
          {" · code "}<span className="font-mono" title={r.codeVersion}>{checksum8(r.codeVersion)}</span>
          {" · result "}<span className="font-mono" title={r.resultChecksum ?? undefined}>{checksum8(r.resultChecksum)}</span>
        </span>
      </div>
      {r.observations.length === 0 ? (
        <p className="px-3 pb-2 text-[11px] text-muted">
          No headline observations persisted for this run{r.resultChecksum ? " — the checksummed result artifact is the record" : ""}.
        </p>
      ) : (
        <table className="w-full">
          <thead><tr><Th>Metric</Th><Th>Scope</Th><Th>Value</Th><Th>N</Th><Th>95% CI</Th></tr></thead>
          <tbody>
            {r.observations.map((o) => (
              <tr key={o.id}>
                <Td className="font-mono text-[12px] text-ink">{o.metric}</Td>
                <Td className="text-ink2">{o.scope}</Td>
                <Td className="num">{o.valueText ?? (o.value !== null ? String(o.value) : "—")}</Td>
                <Td className="num">{o.n ?? "—"}</Td>
                <Td className="num text-muted">{o.ciLo !== null && o.ciHi !== null ? `${o.ciLo} … ${o.ciHi}` : "—"}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {r.params && Object.keys(r.params).length > 0 && (
        <p className="px-3 pb-2 text-[11px] text-muted truncate" title={JSON.stringify(r.params)}>
          params: <span className="font-mono">{JSON.stringify(r.params)}</span>
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ManifestTable({ manifests }: { manifests: ManifestRow[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr>
            <Th>Dataset</Th><Th>Title</Th><Th>License</Th><Th>Window</Th><Th>Rows</Th>
            <Th>Files</Th><Th>Checksum</Th><Th>Status</Th><Th>Retrieved</Th>
          </tr>
        </thead>
        <tbody>
          {manifests.map((m) => (
            <ManifestRows key={m.id} manifest={m} open={openId === m.id} onToggle={() => setOpenId(openId === m.id ? null : m.id)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ManifestRows({ manifest: m, open, onToggle }: { manifest: ManifestRow; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr onClick={onToggle} className={`cursor-pointer hover:bg-panel2 ${open ? "bg-panel2" : ""}`}>
        <Td className="font-mono text-[12px] text-ink whitespace-nowrap">{m.datasetKey}</Td>
        <Td className="max-w-[22rem]"><span className="block truncate text-ink2" title={m.title}>{m.title}</span></Td>
        <Td>{m.license ?? "—"}</Td>
        <Td className="num text-muted whitespace-nowrap">
          {m.timeRangeStartMs !== null && m.timeRangeEndMs !== null
            ? `${fmtTs(m.timeRangeStartMs).slice(0, 10)} → ${fmtTs(m.timeRangeEndMs).slice(0, 10)}`
            : "—"}
        </Td>
        <Td className="num">{m.rowCount !== null ? nfmt(m.rowCount) : "—"}</Td>
        <Td className="num whitespace-nowrap">
          {m.checksummedFiles}/{m.fileCount} checksummed
          {m.fileCount > 0 && <span className="text-muted"> ({pct(m.checksummedFiles, m.fileCount, 0)})</span>}
        </Td>
        <Td><span className="font-mono text-[12px] text-muted" title={m.contentChecksum}>{checksum8(m.contentChecksum)}</span></Td>
        <Td><MaterializedBadge materialized={m.materialized} /></Td>
        <Td className="num text-muted whitespace-nowrap">{fmtTs(m.retrievedAtMs)}</Td>
      </tr>
      {open && (
        <tr className="bg-panel2/50">
          <td colSpan={9} className="px-4 py-3 border-b border-grid">
            <div className="grid grid-cols-2 gap-4 text-[12px]">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted mb-1">Files</div>
                <table className="w-full">
                  <thead><tr><Th>Path</Th><Th>sha256</Th><Th>Bytes</Th><Th>Rows</Th></tr></thead>
                  <tbody>
                    {m.files.map((f) => (
                      <tr key={f.path}>
                        <Td className="font-mono text-[11px] text-ink2">{f.path}</Td>
                        <Td className="font-mono text-[11px]">
                          {f.sha256 ? (
                            <span title={f.sha256} className="text-ink2">{checksum8(f.sha256)}</span>
                          ) : (
                            <span className="text-warning">absent on this machine</span>
                          )}
                        </Td>
                        <Td className="num">{f.bytes !== null ? nfmt(f.bytes) : "—"}</Td>
                        <Td className="num">{f.rows !== null ? nfmt(f.rows) : "—"}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="space-y-2">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted mb-0.5">Source / provenance</div>
                  <p className="text-ink2 break-words">{m.source}</p>
                </div>
                {m.schemaDescription && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-muted mb-0.5">Schema</div>
                    <p className="text-ink2">{m.schemaDescription}</p>
                  </div>
                )}
                <div className="num text-muted">
                  content checksum <span className="font-mono" title={m.contentChecksum}>{checksum8(m.contentChecksum)}</span>
                  {" · recorded "}{fmtTs(m.createdAtMs)}
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

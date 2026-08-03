"use client";

/**
 * Shared response types + display metadata for the Evidence Lab page. These
 * mirror the read-only /api/evidence/* routes in apps/api/src/server.ts.
 * The label vocabulary mirrors packages/evidence/src/labels.ts — a claim's
 * label may only move "up" (toward LIVE_VALIDATED) through a recorded
 * reproduction or live measurement, never by assertion.
 */

export const EVIDENCE_LABELS = [
  "SOURCE_CLAIM_UNVERIFIED",
  "OFFICIAL_CURRENT_AT_RETRIEVAL",
  "REPRODUCED_MATCH",
  "REPRODUCED_MISMATCH",
  "DATA_GATED",
  "INTERNAL_HYPOTHESIS",
  "LIVE_VALIDATED",
  "REJECTED_ANTI_PATTERN",
] as const;
export type EvidenceLabel = (typeof EVIDENCE_LABELS)[number];

/**
 * Epistemic badge treatment. Status colors carry state, never color alone —
 * the badge text is the label itself and the caption repeats the meaning.
 * REPRODUCED_MISMATCH and DATA_GATED get the same visual weight as a match:
 * a failed or untestable reproduction is as visible as a success.
 */
export const LABEL_META: Record<EvidenceLabel, { cls: string; caption: string }> = {
  SOURCE_CLAIM_UNVERIFIED: {
    cls: "bg-panel2 text-ink2 border-hairline border-dashed",
    caption: "Source claim — not reproduced.",
  },
  OFFICIAL_CURRENT_AT_RETRIEVAL: {
    cls: "bg-up/15 text-up border-up/40",
    caption: "Read from official docs/API at a recorded time; the live market object still overrides prose.",
  },
  REPRODUCED_MATCH: {
    cls: "bg-good/15 text-good border-good/40",
    caption: "Our reproduction agrees within stated tolerance.",
  },
  REPRODUCED_MISMATCH: {
    cls: "bg-serious/20 text-serious border-serious/60",
    caption: "Our reproduction disagrees — the mismatch itself is the finding and stays visible.",
  },
  DATA_GATED: {
    cls: "bg-warning/15 text-warning border-warning/50",
    caption: "Reproduction harness exists but the required dataset does not. Awaiting data — never faked.",
  },
  INTERNAL_HYPOTHESIS: {
    cls: "bg-panel2 text-ink border-hairline",
    caption: "Our own idea; needs a preregistered experiment before it can move up.",
  },
  LIVE_VALIDATED: {
    cls: "bg-good/25 text-good border-good/70",
    caption: "Confirmed on our own live/paper fills.",
  },
  REJECTED_ANTI_PATTERN: {
    cls: "bg-critical/15 text-critical border-critical/50",
    caption: "Demonstrated unsafe or unsound; code prevents it from reaching an armed path.",
  },
};

/** Count tone per label for the census strip (hue only — size and weight are identical). */
export const LABEL_COUNT_TONE: Record<EvidenceLabel, string> = {
  SOURCE_CLAIM_UNVERIFIED: "text-ink2",
  OFFICIAL_CURRENT_AT_RETRIEVAL: "text-up",
  REPRODUCED_MATCH: "text-good",
  REPRODUCED_MISMATCH: "text-serious",
  DATA_GATED: "text-warning",
  INTERNAL_HYPOTHESIS: "text-ink",
  LIVE_VALIDATED: "text-good",
  REJECTED_ANTI_PATTERN: "text-critical",
};

/** HypothesisStatus (packages/experiments/src/types.ts) badge treatment. */
export const HYPOTHESIS_STATUS_CLS: Record<string, string> = {
  PREREGISTERED: "bg-panel2 text-ink2 border-hairline",
  RUNNING: "bg-up/15 text-up border-up/40",
  SUPPORTED: "bg-good/15 text-good border-good/40",
  REFUTED: "bg-serious/20 text-serious border-serious/60",
  INCONCLUSIVE: "bg-panel2 text-muted border-hairline",
  DATA_GATED: "bg-warning/15 text-warning border-warning/50",
};

// ---------- API payloads ----------

export interface LedgerDataset {
  id: string;
  datasetKey: string;
  title: string;
  materialized: boolean;
  contentChecksum: string;
}

export interface LedgerReproduction {
  runId: string;
  runKey: string;
  status: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  codeVersion: string;
  resultChecksum: string | null;
  definitionId: string;
  experimentKey: string | null;
  experimentTitle: string | null;
  dataGated: boolean;
}

export interface LedgerClaim {
  id: string;
  sourceKey: string;
  claimKey: string;
  title: string;
  claimText: string;
  claimedValue: string | null;
  units: string | null;
  label: EvidenceLabel;
  url: string | null;
  retrievedAtMs: number | null;
  reproducedValue: string | null;
  methodologyNotes: string | null;
  configVersion: number | null;
  createdAtMs: number;
  updatedAtMs: number;
  reproduction: LedgerReproduction | null;
  datasets: LedgerDataset[];
}

export interface LedgerPayload {
  claims: LedgerClaim[];
  counts: Record<string, number>;
  labels: string[];
  notes: string[];
  note?: string;
}

export interface ExperimentObservationRow {
  id: string;
  metric: string;
  scope: string;
  value: number | null;
  valueText: string | null;
  n: number | null;
  ciLo: number | null;
  ciHi: number | null;
}

export interface ExperimentRunRow {
  id: string;
  runKey: string;
  status: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  codeVersion: string;
  configVersion: number | null;
  resultChecksum: string | null;
  params: Record<string, unknown> | null;
  datasetManifestIds: string[];
  dataGated: boolean;
  observations: ExperimentObservationRow[];
}

export interface ExperimentRow {
  id: string;
  experimentKey: string;
  title: string;
  hypothesis: string;
  nullHypothesis: string;
  primaryMetric: string;
  successCriteria: string;
  status: string;
  foldPlan: Record<string, unknown> | null;
  datasetKeys: string[];
  sourceEvidenceIds: string[];
  dataGated: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  runs: ExperimentRunRow[];
}

export interface ExperimentsPayload {
  experiments: ExperimentRow[];
  note?: string;
}

export interface ManifestFile {
  path: string;
  sha256: string | null;
  bytes: number | null;
  rows: number | null;
}

export interface ManifestRow {
  id: string;
  datasetKey: string;
  title: string;
  source: string;
  license: string | null;
  contentChecksum: string;
  materialized: boolean;
  rowCount: number | null;
  timeRangeStartMs: number | null;
  timeRangeEndMs: number | null;
  schemaDescription: string | null;
  retrievedAtMs: number | null;
  createdAtMs: number;
  files: ManifestFile[];
  fileCount: number;
  checksummedFiles: number;
}

export interface ManifestsPayload {
  manifests: ManifestRow[];
  note?: string;
}

// ---------- sample-count reconciliation ----------

export interface CountPair {
  claimed: number;
  reproduced: number;
  gap: number; // reproduced − claimed; nonzero must be accounted for, not hidden
}

/**
 * Pair up integer counts from a claimed/reproduced value pair. Only fires when
 * both strings carry the same number of numeric tokens and a token pair is
 * integer-valued on both sides (counts, not rates) — e.g. the favored-side
 * study's 4,569 claimed decisions vs a 4,442 band sum yields gap −127.
 */
export function countPairs(claimed: string | null, reproduced: string | null): CountPair[] {
  if (!claimed || !reproduced) return [];
  const nums = (s: string): number[] =>
    (s.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? [])
      .map((t) => Number(t.replace(/,/g, "")))
      .filter((n) => Number.isFinite(n));
  const a = nums(claimed);
  const b = nums(reproduced);
  if (a.length === 0 || a.length !== b.length) return [];
  return a.flatMap((c, i) => {
    const r = b[i]!;
    // counts are positive integers — this also rejects horizon tokens like "T-60s"
    if (!Number.isInteger(c) || !Number.isInteger(r) || c < 10 || r < 0) return [];
    return [{ claimed: c, reproduced: r, gap: r - c }];
  });
}

export const nfmt = (n: number): string => n.toLocaleString("en-US");

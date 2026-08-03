import type { FoldPlan, HypothesisStatus } from "@b5p/experiments";
import type { EvidenceLabel } from "@b5p/evidence";

/**
 * Phase-2 source-reproduction harness types (R1-R8, R11 of
 * 2026-07-31-001-initial-refinement.md).
 *
 * A reproduction is PREREGISTERED: the definition (hypothesis, null, primary
 * metric, decision rule, fold plan) is frozen before any run; changing the
 * primary metric produces a DIFFERENT definition id (content-addressed), so a
 * moved goalpost is a new experiment, never a silent edit.
 */

export interface PreregisteredDefinition {
  /** Stable slug, e.g. "R3_favored_side_calibration". */
  experimentKey: string;
  title: string;
  hypothesis: string;
  nullHypothesis: string;
  /** The single metric that decides the hypothesis. */
  primaryMetric: string;
  /** Preregistered decision rule over the primary metric. */
  successCriteria: string;
  /** source_evidence ids this experiment tests (deterministic ids we own). */
  sourceEvidenceIds: string[];
  datasetKeys: string[];
  foldPlan: FoldPlan | null;
}

/** Mirrors the Python observation contract (repro_common.py `obs`). */
export interface PyObservation {
  metric: string;
  scope: string;
  value: number | null;
  valueText: string | null;
  n: number | null;
  ciLo: number | null;
  ciHi: number | null;
  detail: Record<string, unknown> | null;
}

export interface PyPerDayRow {
  day: string;
  scope: string;
  n: number;
  k?: number;
  [extra: string]: unknown;
}

export interface PyResultDoc {
  experiment: string;
  params: Record<string, unknown>;
  dataset: Record<string, unknown>;
  observations: PyObservation[];
  perDay: PyPerDayRow[];
}

/** Verdict of one source claim vs our reproduction. */
export type ReproVerdict = Extract<
  EvidenceLabel,
  "REPRODUCED_MATCH" | "REPRODUCED_MISMATCH" | "DATA_GATED"
>;

export interface ClaimComparison {
  /** Deterministic source_evidence row id (we own the se-repro-* namespace). */
  evidenceId: string;
  sourceKey: string;
  claimKey: string;
  title: string;
  claimText: string;
  claimedValue: string | null;
  units: string | null;
  /** Preregistered rule that decides MATCH vs MISMATCH (recorded verbatim). */
  matchRule: string;
  reproducedValue: string | null;
  verdict: ReproVerdict;
  /** Exact missing dataset when verdict is DATA_GATED. */
  gatedBy: string | null;
  notes: string | null;
}

export interface DatasetChecksumEntry {
  path: string; // workspace-relative
  sha256: string | null;
  bytes: number | null;
}

export interface ReproRunResult {
  status: "COMPLETED" | "FAILED";
  /** Status the preregistered decision rule assigns after this run. */
  hypothesisStatus: HypothesisStatus;
  observations: PyObservation[];
  perDay: PyPerDayRow[];
  comparisons: ClaimComparison[];
  /** Files actually consumed, checksummed at run time. */
  datasetChecksums: DatasetChecksumEntry[];
  params: Record<string, unknown>;
  summary: Record<string, unknown>;
  runtimeMs: number;
  /** Human-readable one-liner for the CLI. */
  headline: string;
  error?: string;
}

export interface ReproContext {
  root: string;
  pythonBin: string;
  /** Directory for python result JSON files. */
  outDir: string;
  /** kachoio dataset paths (or smoke-fixture paths in tests). */
  marketsPath: string;
  ticksPath: string;
  /** Collector export dir (may not exist -> collector-dependent parts gate). */
  collectorDir: string;
  datasetKey: string;
  seed: number;
  quick: boolean;
  nowMs: number;
  codeVersion: string;
}

export interface ReproExperiment {
  key: string;
  definition: Readonly<PreregisteredDefinition>;
  /** @b5p/evidence fixture export names this experiment compares against. */
  requiredFixtures: string[];
  run(ctx: ReproContext): Promise<ReproRunResult>;
}

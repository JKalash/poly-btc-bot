import type { FoldPlan } from "./folds";

/**
 * Reproducible-experiment primitives. Pure and DB-agnostic: the db package
 * mirrors these as tables; apps/research materializes runs.
 *
 * An experiment is PREREGISTERED: hypothesis, null, primary metric and the
 * decision rule are written down before the run. A failed or untestable
 * reproduction must be as visible as a success — hence DATA_GATED and REFUTED
 * are first-class statuses, not absences.
 */

export type HypothesisStatus =
  | "PREREGISTERED"
  | "RUNNING"
  | "SUPPORTED"
  | "REFUTED"
  | "INCONCLUSIVE"
  | "DATA_GATED";

export const HYPOTHESIS_STATUSES: readonly HypothesisStatus[] = [
  "PREREGISTERED", "RUNNING", "SUPPORTED", "REFUTED", "INCONCLUSIVE", "DATA_GATED",
];

export interface ExperimentDefinition {
  id: string;
  /** Stable slug, e.g. "R3_favored_side_calibration". */
  experimentKey: string;
  title: string;
  /** Preregistered hypothesis, stated before any run. */
  hypothesis: string;
  nullHypothesis: string;
  /** The single metric that decides the hypothesis (others are descriptive). */
  primaryMetric: string;
  /** Preregistered decision rule, e.g. "lower 95% CI of net EV per trade > 0". */
  successCriteria: string;
  /** source_evidence.id rows this experiment tests. */
  sourceEvidenceIds: string[];
  /** dataset_manifests.datasetKey values the experiment consumes. */
  datasetKeys: string[];
  foldPlan: FoldPlan | null;
  status: HypothesisStatus;
  createdAtMs: number;
  updatedAtMs: number;
}

export type ExperimentRunStatus = "RUNNING" | "COMPLETED" | "FAILED";

export interface ExperimentRun {
  id: string;
  definitionId: string;
  /** Human-stable run slug, e.g. "R3_2026-08_kachoio_v1". */
  runKey: string;
  params: Record<string, unknown>;
  /** dataset_manifests.id rows actually consumed (with checksums). */
  datasetManifestIds: string[];
  /** Code identity: git sha or engine version string. */
  codeVersion: string;
  configVersion: number | null;
  status: ExperimentRunStatus;
  startedAtMs: number;
  finishedAtMs: number | null;
  resultSummary: Record<string, unknown> | null;
  /** sha256 over the canonical JSON of the full result payload. */
  resultChecksum: string | null;
  correlationId: string;
}

export interface ExperimentObservation {
  id: string;
  runId: string;
  metric: string;
  /** Scope of the observation: "overall", a fold id, a price bucket, ... */
  scope: string;
  value: number | null;
  /** Exact value as text when doubles would lose precision. */
  valueText: string | null;
  n: number | null;
  ciLo: number | null;
  ciHi: number | null;
  detail: Record<string, unknown> | null;
  createdAtMs: number;
}

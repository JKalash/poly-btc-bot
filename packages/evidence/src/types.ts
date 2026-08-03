import type { EvidenceLabel } from "./labels";

/**
 * Provenance types. Every research claim and every dataset that feeds a model
 * or a strategy is representable here, so "where did this number come from?"
 * always has a queryable answer.
 */

/** A single claim from a source (or from us), with its verification status. */
export interface SourceEvidence {
  id: string;
  /** Stable source slug, e.g. "reddit_efficient_markets_2026", "archetapp_gist", "polymarket_docs". */
  sourceKey: string;
  /** Stable claim slug within the source, e.g. "favored_side_calibration_table". */
  claimKey: string;
  title: string;
  /** The claim exactly as the source states it (quote or faithful paraphrase, flagged which). */
  claimText: string;
  /** Claimed numeric/text value exactly as printed by the source, when the claim is a value. */
  claimedValue: string | null;
  units: string | null;
  label: EvidenceLabel;
  url: string | null;
  retrievedAtMs: number | null;
  /** Our reproduced value, when a reproduction ran. */
  reproducedValue: string | null;
  /** experiment_runs.id of the reproduction that produced reproducedValue. */
  reproductionRunId: string | null;
  methodologyNotes: string | null;
  correlationId: string;
  configVersion: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface DatasetFileEntry {
  path: string;
  sha256: string | null; // null when the file is not present on this machine (data-gated)
  bytes: number | null;
  rows: number | null;
}

/** Immutable description of a dataset snapshot used by an experiment or model. */
export interface DatasetManifest {
  id: string;
  /** Stable dataset slug, e.g. "kachoio_btc5m_mar_may_2026". */
  datasetKey: string;
  title: string;
  /** Where it came from: URL, collection process, or upstream provenance. */
  source: string;
  license: string | null;
  files: DatasetFileEntry[];
  /**
   * sha256 over the canonical JSON of `files` — a manifest-level fingerprint.
   * Two manifests with the same contentChecksum describe byte-identical data.
   */
  contentChecksum: string;
  timeRangeStartMs: number | null;
  timeRangeEndMs: number | null;
  rowCount: number | null;
  schemaDescription: string | null;
  /** True when the described files are actually present and checksummed here. */
  materialized: boolean;
  retrievedAtMs: number | null;
  createdAtMs: number;
}

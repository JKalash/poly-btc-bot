import type { ReproExperiment } from "./types";

import { R1_FEED_LAG } from "./r1-feed-lag";
import { R2_MOMENTUM } from "./r2-momentum";
import { R3_FAVORED_SIDE } from "./r3-favored-side";
import { R4_TREND_SIDE } from "./r4-trend-side";
import { R5_ENTRY_SURFACE } from "./r5-entry-surface";
import { R6_EXITS } from "./r6-exits";
import { R7_GIST_COMPOSITE } from "./r7-gist-composite";
import { R8_FADE } from "./r8-fade";
import { R11_HIGHER_BAND } from "./r11-higher-band";

/**
 * Registry of the Phase-2 source-reproduction experiments (R1-R8, R11 of
 * 2026-07-31-001-initial-refinement.md; R9/R10/R12 are execution/inventory/
 * wallet subsystems owned elsewhere).
 *
 * Ordered cheap-first so a partial run still lands the fast experiments.
 */
export const REPRO_EXPERIMENTS: readonly ReproExperiment[] = [
  R1_FEED_LAG,
  R7_GIST_COMPOSITE,
  R2_MOMENTUM,
  R8_FADE,
  R5_ENTRY_SURFACE,
  R11_HIGHER_BAND,
  R4_TREND_SIDE,
  R3_FAVORED_SIDE,
  R6_EXITS,
];

/** Short aliases accepted by the CLI: r1, R3, r11, ... */
export function findExperiment(name: string): ReproExperiment | undefined {
  const n = name.trim().toLowerCase();
  return REPRO_EXPERIMENTS.find(
    (e) => e.key.toLowerCase() === n || e.key.toLowerCase().startsWith(`${n}_`),
  );
}

export * from "./types";
export * from "./common";
export * from "./verdicts";
export { exportCollector, COLLECTOR_DATASET_KEY, COLLECTOR_MANIFEST_ID } from "./export-collector";
export { persistReproRun, type PersistReproResult } from "./persist";

/**
 * Source fixtures: exact transcriptions of every numeric table in the two
 * research sources, per 2026-07-31-001-initial-refinement.fable ("Every Reddit
 * numeric table is represented exactly"; "The gist's seven weights and
 * thresholds are represented exactly").
 *
 * Everything here is a SOURCE'S claim (label SOURCE_CLAIM_UNVERIFIED), never
 * truth, never a live signal, never a runtime default.
 */

export * from "./provenance";
export * from "./reddit-favored-side-bands";
export * from "./reddit-trend-side-bands";
export * from "./reddit-momentum-continuation";
export * from "./reddit-sustained-run";
export * from "./reddit-lag-arm-and-watch";
export * from "./reddit-exit-pullback-recovery";
export * from "./reddit-yearly-reversal-rates";
export * from "./gist-composite";
export * from "./gist-synthetic-delta-curve";
export * from "./gist-modes";

import type { SourceFixture } from "./provenance";
import { REDDIT_FAVORED_SIDE_BANDS } from "./reddit-favored-side-bands";
import { REDDIT_TREND_SIDE_BANDS } from "./reddit-trend-side-bands";
import { REDDIT_MOMENTUM_CONTINUATION } from "./reddit-momentum-continuation";
import { REDDIT_SUSTAINED_RUN } from "./reddit-sustained-run";
import { REDDIT_LAG_ARM_AND_WATCH } from "./reddit-lag-arm-and-watch";
import { REDDIT_EXIT_PULLBACK_RECOVERY } from "./reddit-exit-pullback-recovery";
import { REDDIT_YEARLY_REVERSAL_RATES } from "./reddit-yearly-reversal-rates";
import { GIST_COMPOSITE_WEIGHTS, GIST_THRESHOLDS } from "./gist-composite";
import { GIST_SYNTHETIC_DELTA_CURVE } from "./gist-synthetic-delta-curve";
import { GIST_MODES } from "./gist-modes";

/** Version tag for this fixture set (matches research.source_reproduction.source_fixture_version). */
export const SOURCE_FIXTURE_VERSION = "2026-07-31-001" as const;

/**
 * Manifest of every source fixture, keyed by fixture id. Each entry carries
 * its own provenance (`sourceRef`) and label. Reproduction harnesses iterate
 * this rather than importing tables ad hoc, so no claim can be consumed
 * without its provenance attached.
 */
export const SOURCE_FIXTURES = {
  // Keys are the fixture ids verbatim; a test asserts key === value.id.
  reddit_favored_side_bands_v1: REDDIT_FAVORED_SIDE_BANDS,
  reddit_trend_side_bands_v1: REDDIT_TREND_SIDE_BANDS,
  reddit_momentum_continuation_v1: REDDIT_MOMENTUM_CONTINUATION,
  reddit_sustained_run_v1: REDDIT_SUSTAINED_RUN,
  reddit_lag_arm_and_watch_v1: REDDIT_LAG_ARM_AND_WATCH,
  reddit_exit_pullback_recovery_v1: REDDIT_EXIT_PULLBACK_RECOVERY,
  reddit_yearly_reversal_rates_v1: REDDIT_YEARLY_REVERSAL_RATES,
  gist_composite_weights_v1: GIST_COMPOSITE_WEIGHTS,
  gist_thresholds_v1: GIST_THRESHOLDS,
  gist_synthetic_delta_curve_v1: GIST_SYNTHETIC_DELTA_CURVE,
  gist_modes_v1: GIST_MODES,
} as const satisfies Record<string, SourceFixture<unknown>>;

export type SourceFixtureId = keyof typeof SOURCE_FIXTURES;

export function getSourceFixture(id: SourceFixtureId): SourceFixture<unknown> {
  return SOURCE_FIXTURES[id];
}

export function listSourceFixtures(): SourceFixture<unknown>[] {
  return Object.values(SOURCE_FIXTURES);
}

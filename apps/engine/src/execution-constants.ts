import type { AppConfig } from "@b5p/config";
import { MARKOUT_HORIZONS_MS } from "@b5p/domain";

/**
 * Execution-research tunables (plan items 1b/1c). Hardcoded defaults live
 * here; when the config schema exposes `execution_research.*` keys (see
 * scratchpad/config-requests-D.md) those win. All fractions are simulation
 * probabilities, NOT money — money stays bigint micro-units everywhere.
 */

export const DEFAULT_MARKOUT_HORIZONS_MS: readonly number[] = MARKOUT_HORIZONS_MS;

/** A pending markout is abandoned (nothing persisted) if no book update newer
 * than the fill arrives within horizon + this grace. midAtHorizon6 is NOT NULL
 * in the schema, so unobservable markouts are dropped, never faked. */
export const MARKOUT_BOOK_GRACE_MS = 30_000;

/** CONSERVATIVE_STRESS defaults (deterministic; RNG seeded from correlationId). */
export const DEFAULT_STRESS_PARAMS = {
  /** Extra simulated latency before the stress variant's order becomes active. */
  extraLatencyMs: 500,
  /** Fills execute this many ticks worse than the queue-replay fill price. */
  tickDisadvantageTicks: 1,
  /** Each queue-replay fill is independently missed with this probability. */
  missedFillFraction: 0.25,
  /** On cancel, probability the cancel "fails" — charged as an adverse-selection
   * penalty on the remaining notional (cost-only; never grants shares, so the
   * stress variant can never out-fill queue replay). */
  cancelFailFraction: 0.10,
  /** Adverse-selection markout penalty, basis points of filled notional,
   * subtracted from the stress variant's P&L. */
  adverseMarkoutPenaltyBps: 100,
} as const;

export type StressParams = {
  extraLatencyMs: number;
  tickDisadvantageTicks: number;
  missedFillFraction: number;
  cancelFailFraction: number;
  adverseMarkoutPenaltyBps: number;
};

/** Fill-counterfactual recorder bounds (memory safety in the hot path). */
export const COUNTERFACTUAL_MAX_WATCHES = 256;
export const COUNTERFACTUAL_MAX_EVIDENCE = 20;

/** Buffered persistence: max rows held before oldest are dropped (with a warn). */
export const EXECUTION_BUFFER_MAX_ROWS = 5_000;

export interface ResolvedExecutionResearchConfig {
  markoutHorizonsMs: readonly number[];
  recordFillCounterfactuals: boolean;
  stress: StressParams;
}

/** Merge config-schema keys (when present) over the hardcoded defaults. */
export function resolveExecutionResearchConfig(cfg: AppConfig): ResolvedExecutionResearchConfig {
  const er = (cfg as { execution_research?: {
    markout_horizons_ms?: number[];
    record_fill_counterfactuals?: boolean;
    paper_variants?: {
      stress_extra_latency_ms?: number;
      stress_tick_disadvantage_ticks?: number;
      stress_missed_fill_fraction?: string;
      stress_cancel_fail_fraction?: string;
    };
  } }).execution_research;
  const pv = er?.paper_variants;
  return {
    markoutHorizonsMs: er?.markout_horizons_ms ?? DEFAULT_MARKOUT_HORIZONS_MS,
    recordFillCounterfactuals: er?.record_fill_counterfactuals ?? true,
    stress: {
      extraLatencyMs: pv?.stress_extra_latency_ms ?? DEFAULT_STRESS_PARAMS.extraLatencyMs,
      tickDisadvantageTicks: pv?.stress_tick_disadvantage_ticks ?? DEFAULT_STRESS_PARAMS.tickDisadvantageTicks,
      missedFillFraction: fracOr(pv?.stress_missed_fill_fraction, DEFAULT_STRESS_PARAMS.missedFillFraction),
      cancelFailFraction: fracOr(pv?.stress_cancel_fail_fraction, DEFAULT_STRESS_PARAMS.cancelFailFraction),
      adverseMarkoutPenaltyBps: DEFAULT_STRESS_PARAMS.adverseMarkoutPenaltyBps, // not yet in config schema
    },
  };
}

function fracOr(s: string | undefined, fallback: number): number {
  if (s === undefined) return fallback;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

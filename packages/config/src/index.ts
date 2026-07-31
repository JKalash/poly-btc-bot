import { z } from "zod";

/**
 * Validated application configuration. Mirrors the spec's YAML schema.
 * Config versions are stored in the database; environment variables may
 * override deployment/secrets only — NEVER risk limits (enforced by the
 * fact that no code path reads risk config from the environment).
 *
 * Fractions are decimal strings, converted to exact ppm at the domain edge.
 */

const fraction = z.string().regex(/^\d+(\.\d{1,6})?$/, "decimal fraction with <=6 places");

export const AppConfigSchema = z.object({
  app: z.object({
    timezone_display: z.string().default("Europe/Madrid"),
    calculation_timezone: z.literal("UTC").default("UTC"),
    mode: z.enum(["observe", "paper", "shadow", "live"]).default("paper"),
    bind_host: z.string().default("127.0.0.1"),
    require_auth: z.boolean().default(true),
  }).default({}),

  market: z.object({
    asset: z.literal("BTC").default("BTC"),
    series_slug: z.string().default("btc-up-or-down-5m"),
    series_id_hint: z.string().default("10684"),
    slug_prefix: z.string().default("btc-updown-5m-"),
    duration_seconds: z.number().int().default(300),
    discover_ahead_windows: z.number().int().min(1).max(6).default(3),
    rules_must_name_chainlink: z.boolean().default(true),
  }).default({}),

  feeds: z.object({
    chainlink: z.object({
      required: z.boolean().default(true),
      max_age_ms: z.number().int().default(1500),
      max_gap_ms: z.number().int().default(2500),
    }).default({}),
    binance: z.object({
      required: z.boolean().default(false),
      max_age_ms: z.number().int().default(1500),
    }).default({}),
    clob: z.object({
      max_book_age_ms: z.number().int().default(1000),
    }).default({}),
    clock: z.object({
      max_drift_ms: z.number().int().default(100),
    }).default({}),
    warmup_seconds: z.number().int().default(120),
  }).default({}),

  strategy: z.object({
    active_version: z.enum(["book_distance_v1", "late_snipe_composite_v1"]).default("book_distance_v1"),
    candidate_seconds_remaining_min: z.number().int().default(60),
    candidate_seconds_remaining_max: z.number().int().default(120),
    live_entry_cutoff_seconds: z.number().int().default(60),
    paper_entry_cutoff_seconds: z.number().int().default(15),
    min_conservative_edge: fraction.default("0.02"),
    min_expected_value_per_cost: fraction.default("0.01"),
    live_price_ceiling: fraction.default("0.90"),
    maker_only: z.boolean().default(true),
    allow_taker: z.boolean().default(false),
    cancel_seconds_remaining: z.number().int().default(45),
    volatility_model: z.enum(["empirical_ewma", "sqrt_time"]).default("empirical_ewma"),
    probability_model: z.enum(["book_baseline", "distance_vol_heuristic", "binance_composite", "calibrated_logistic"]).default("book_baseline"),
    calibration_required: z.boolean().default(true),
    minute_bucket_standalone_signal: z.literal(false).default(false),
    min_abs_distance_z: z.number().default(0.5),
    min_depth_shares: z.number().default(100),
    late_snipe: z.object({
      snipe_seconds_remaining_min: z.number().int().min(3).default(5),
      snipe_seconds_remaining_max: z.number().int().default(30),
      min_confidence: z.number().min(0.05).default(0.30),
      max_price: fraction.default("0.97"),
    }).default({}),
    exit_policy: z.enum([
      "hold_to_resolution", "threshold_cross_invalidation", "probability_vs_bid_exit", "time_based_exit",
    ]).default("hold_to_resolution"),
  }).default({}),

  risk: z.object({
    profile: z.enum(["paper_exploration", "aggressive", "very_aggressive", "custom"]).default("paper_exploration"),
    base_risk_fraction: fraction.default("0.05"),
    max_risk_fraction: fraction.default("0.10"),
    session_loss_limit: fraction.default("0.15"),
    daily_loss_limit: fraction.default("0.20"),
    consecutive_loss_limit: z.number().int().min(1).default(2),
    max_open_positions: z.literal(1).default(1),
    kelly_multiplier: fraction.default("0.50"),
    paper_stake_usdc: fraction.default("100"),
    starting_paper_bankroll_usdc: fraction.default("1000"),
    no_martingale: z.literal(true).default(true),
    no_averaging_down: z.literal(true).default(true),
    auto_rearm: z.literal(false).default(false),
  }).default({}),

  execution: z.object({
    post_only: z.boolean().default(true),
    time_in_force: z.enum(["GTC", "GTD"]).default("GTD"),
    permit_partial_fills: z.boolean().default(true),
    max_price_impact: fraction.default("0.005"),
    max_spread: fraction.default("0.02"),
    idempotency_required: z.literal(true).default(true),
    reconcile_after_every_fill: z.boolean().default(true),
    price_improvement_ticks: z.number().int().min(0).default(1),
  }).default({}),

  paper: z.object({
    simulated_latency_ms: z.number().int().default(350),
    queue_model: z.enum(["conservative", "optimistic"]).default("conservative"),
    partial_fill_model: z.boolean().default(true),
    adverse_selection_penalty: z.boolean().default(true),
    current_fee_schedule: z.boolean().default(true),
    fee_collection_convention: z.enum(["usdc", "shares"]).default("usdc"),
    /**
     * Paper-only sizing simulations, including the gist's modes. These exist
     * so the operator can WATCH the ruin dynamics of aggressive sizing on
     * simulated money. They are structurally unreachable from shadow/live
     * paths (the risk engine's absolute cap applies there regardless).
     *  - profile:        stake from the active risk profile (default)
     *  - fixed_stake:    flat simulated amount per trade
     *  - gist_safe:      25% of simulated bankroll per trade
     *  - gist_aggressive:all profits above starting principal
     *  - gist_degen:     entire simulated bankroll every trade (ruin demo)
     */
    sizing_simulation: z.enum(["profile", "fixed_stake", "gist_safe", "gist_aggressive", "gist_degen"]).default("profile"),
  }).default({}),

  live: z.object({
    enabled: z.literal(false).default(false),
    arming_token_ttl_minutes: z.number().int().default(30),
    require_typed_acknowledgement: z.literal(true).default(true),
    require_wallet_reconciliation: z.literal(true).default(true),
    require_shadow_validation: z.literal(true).default(true),
    kill_switch_hotkey: z.boolean().default(true),
  }).default({}),

  research: z.object({
    rolling_windows_days: z.array(z.number().int()).default([7, 14, 30, 60, 90]),
    multiple_testing_correction: z.string().default("benjamini_hochberg_and_bonferroni"),
    walk_forward_only: z.literal(true).default(true),
    minimum_candidate_count: z.number().int().default(1000),
    minimum_fill_count_before_live: z.number().int().default(300),
  }).default({}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export const DEFAULT_CONFIG: AppConfig = AppConfigSchema.parse({});

/**
 * ABSOLUTE SAFETY CAP: no configuration may push per-market risk above this
 * fraction. Changing it requires editing this constant and updating tests —
 * by design (spec: "blocked in the first production release unless the source
 * code's explicit absolute safety cap is changed").
 */
export const ABSOLUTE_MAX_RISK_FRACTION = "0.10";

export interface ConfigValidationIssue {
  path: string;
  message: string;
}

export function validateConfig(raw: unknown): { ok: true; config: AppConfig } | { ok: false; issues: ConfigValidationIssue[] } {
  const parsed = AppConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    };
  }
  const cfg = parsed.data;
  const issues: ConfigValidationIssue[] = [];
  if (Number(cfg.risk.max_risk_fraction) > Number(ABSOLUTE_MAX_RISK_FRACTION)) {
    issues.push({
      path: "risk.max_risk_fraction",
      message: `exceeds the absolute safety cap ${ABSOLUTE_MAX_RISK_FRACTION}; this build refuses per-market risk above 10%`,
    });
  }
  if (Number(cfg.risk.base_risk_fraction) > Number(cfg.risk.max_risk_fraction)) {
    issues.push({ path: "risk.base_risk_fraction", message: "base risk exceeds max risk fraction" });
  }
  if (cfg.strategy.candidate_seconds_remaining_min >= cfg.strategy.candidate_seconds_remaining_max) {
    issues.push({ path: "strategy.candidate_seconds_remaining_min", message: "candidate window min must be < max" });
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, config: cfg };
}

/** Diff two configs into dot-path change list (for the config version viewer). */
export function diffConfigs(a: unknown, b: unknown, prefix = ""): Array<{ path: string; from: unknown; to: unknown }> {
  const out: Array<{ path: string; from: unknown; to: unknown }> = [];
  const keys = new Set([...Object.keys((a as object) ?? {}), ...Object.keys((b as object) ?? {})]);
  for (const k of keys) {
    const av = (a as Record<string, unknown>)?.[k];
    const bv = (b as Record<string, unknown>)?.[k];
    const p = prefix ? `${prefix}.${k}` : k;
    if (typeof av === "object" && av !== null && typeof bv === "object" && bv !== null && !Array.isArray(av)) {
      out.push(...diffConfigs(av, bv, p));
    } else if (JSON.stringify(av) !== JSON.stringify(bv)) {
      out.push({ path: p, from: av, to: bv });
    }
  }
  return out;
}

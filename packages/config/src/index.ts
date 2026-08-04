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

/** Parse a validated decimal fraction to exact millionths without using Number. */
function fractionMillionths(value: string): bigint {
  const [whole, decimal = ""] = value.split(".");
  return BigInt(whole!) * 1_000_000n + BigInt(decimal.padEnd(6, "0"));
}

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
    active_version: z.enum(["book_distance_v1", "late_snipe_composite_v1", "extended_move_fade_v1"]).default("book_distance_v1"),
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
    /** Path to the sealed CalibrationArtifact JSON (null: calibrated_logistic estimates nothing, approved for nothing). */
    calibrated_artifact_path: z.string().nullable().default(null),
    /** Path to the persisted StrategyPromotionDecision JSON produced by cli-promote. */
    promotion_decision_path: z.string().nullable().default(null),
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
    /** Research hypothesis (brief R8): fade extended runs. Source-reproduction — never live. */
    extended_move_fade: z.object({
      live_allowed: z.literal(false).default(false),
      minimum_run_blocks: z.number().int().min(4).default(4),
      minimum_candidate_count: z.number().int().min(1).default(1000),
      minimum_run_move_pct: z.number().positive().default(0.8),
      max_entry_price: fraction.default("0.50"),
    }).default({}),
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
    /** Operator cooling-off after the consecutive-loss stop trips; 0 disables. */
    cooling_off_minutes: z.number().int().min(0).default(30),
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

  /** Complete-set pair observer and prospective paper execution (§19). */
  pair: z.object({
    observer_enabled: z.boolean().default(true),
    paper_execution_enabled: z.boolean().default(false),
    live_execution_enabled: z.literal(false).default(false),
    strategy_version: z.literal("complete_set_pair_v0_RESEARCH_ONLY").default("complete_set_pair_v0_RESEARCH_ONLY"),
    route: z.literal("DIRECT_BUY_BOTH").default("DIRECT_BUY_BOTH"),

    maximum_book_age_ms: z.number().int().positive().default(500),
    maximum_source_skew_ms: z.number().int().nonnegative().default(100),
    maximum_receive_skew_ms: z.number().int().nonnegative().default(100),
    maximum_future_timestamp_ms: z.number().int().nonnegative().default(250),
    maximum_fee_snapshot_age_ms: z.number().int().positive().default(300_000),
    maximum_constraint_snapshot_age_ms: z.number().int().positive().default(300_000),

    activation_latency_ms: z.number().int().nonnegative().default(350),
    dispatch_model: z.enum(["PARALLEL", "UP_THEN_DOWN", "DOWN_THEN_UP"]).default("PARALLEL"),
    inter_leg_delay_ms: z.number().int().nonnegative().default(50),
    activation_quote_ttl_ms: z.number().int().positive().default(250),

    maximum_cash_fraction: fraction.default("0.02"),
    maximum_residual_loss_fraction: fraction.default("0.01"),
    maximum_aggregate_reserved_fraction: fraction.default("0.02"),
    maximum_aggregate_residual_loss_fraction: fraction.default("0.01"),
    maximum_active_pair_groups: z.literal(1).default(1),
    maximum_pair_daily_loss_fraction: fraction.default("0.02"),
    maximum_pair_session_drawdown_fraction: fraction.default("0.02"),

    minimum_net_pnl_usdc: fraction.default("0.01"),
    minimum_net_return: fraction.default("0.001"),
    operational_risk_haircut_usdc: fraction.default("0.01"),
    prefilter_band_usdc_per_share: fraction.default("0.005"),
    require_one_tick_stress_positive: z.boolean().default(true),
    require_two_tick_stress_positive: z.boolean().default(false),
    depth_stress_fractions: z.tuple([fraction, fraction, fraction]).default(["0.75", "0.50", "0.25"]),

    pair_share_lot: fraction.default("0.01"),
    maximum_pair_shares: fraction.optional(),
    entry_cutoff_seconds: z.number().int().nonnegative().default(30),

    settlement_policy: z.enum(["HOLD_TO_RESOLUTION", "PAPER_VIRTUAL_MERGE"]).default("HOLD_TO_RESOLUTION"),
    modeled_settlement_delay_ms: z.number().int().nonnegative().default(0),
    modeled_settlement_cost_usdc: fraction.default("0"),
    settlement_cash_reserve_usdc: fraction.default("0"),

    recovery_policy: z.enum([
      "NO_AUTO_RECOVERY",
      "PAPER_COMPLETE_MISSING_LEG",
      "PAPER_LIQUIDATE_FILLED_LEG",
      "PAPER_MINIMIZE_WORST_LOSS",
    ]).default("NO_AUTO_RECOVERY"),
    maximum_recovery_attempts: z.union([z.literal(0), z.literal(1)]).default(0),
    recovery_deadline_ms: z.number().int().positive().default(1_500),
    recovery_reserve_usdc: fraction.default("0"),

    episode_cooloff_ms: z.number().int().nonnegative().default(1_000),
    negative_control_sample_ppm: z.number().int().min(0).max(1_000_000).default(1_000),
    observer_flush_interval_ms: z.number().int().min(10).default(50),
    capture_queue_capacity: z.number().int().positive().default(10_000),
    market_event_batch_size: z.number().int().positive().default(500),
    checkpoint_interval_ms: z.number().int().positive().default(1_000),
    reconcile_interval_ms: z.number().int().positive().default(5_000),
    unknown_result_timeout_ms: z.number().int().positive().default(5_000),
    paper_account_model: z.literal("COUNTERFACTUAL_ISOLATED").default("COUNTERFACTUAL_ISOLATED"),
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
    walk_forward_folds: z.number().int().min(2).default(4),
    walk_forward_embargo_ms: z.number().int().min(0).default(60_000),
    promotion: z.object({
      min_fill_samples: z.number().int().min(1).default(300),
      max_ece: z.number().positive().default(0.05),
      /** Net-EV lower 95% CI must EXCEED this (per-cost fraction) for live promotion. */
      min_net_ev_lower_ci: z.number().default(0),
    }).default({}),
  }).default({}),

  evidence: z.object({
    /** Every strategy/model input claim must carry a provenance row + label. */
    require_provenance: z.boolean().default(true),
    /** OFFICIAL_CURRENT_AT_RETRIEVAL claims older than this are flagged for re-verification. */
    official_reverify_days: z.number().int().min(1).default(30),
  }).default({}),

  execution_research: z.object({
    /** Post-fill markout sampling horizons; resolution markout is always added. */
    markout_horizons_ms: z.array(z.number().int().positive()).default([250, 1000, 2000, 5000, 10_000, 30_000]),
    /** A pending markout is dropped (never fabricated) if no book newer than the fill arrives within horizon + grace. */
    markout_book_grace_ms: z.number().int().min(0).default(30_000),
    /** Record would-be maker fills that did not happen (counterfactual book). */
    record_fill_counterfactuals: z.boolean().default(true),
    /** CONSERVATIVE_STRESS paper-variant knobs (worse latency, one-tick disadvantage, missed fills). */
    paper_variants: z.object({
      stress_extra_latency_ms: z.number().int().min(0).default(500),
      stress_tick_disadvantage_ticks: z.number().int().min(0).default(1),
      stress_missed_fill_fraction: fraction.default("0.25"),
      stress_cancel_fail_fraction: fraction.default("0.10"),
      /** Adverse-selection penalty (bps of filled/remaining notional) charged to CONSERVATIVE_STRESS P&L. */
      stress_adverse_markout_penalty_bps: z.number().int().min(0).default(100),
    }).default({}),
  }).default({}),

  /**
   * Phase 3 R10 paired-cycle inventory/CTF simulation (apps/engine inventory-cycle.ts).
   * Research loop, opt-in, paper/shadow only. The one-leg duration and unhedged-fraction
   * budgets deliberately live ONLY in inventory_risk (single source of truth); the engine
   * syncs the simulator from there.
   */
  inventory_research: z.object({
    enabled: z.boolean().default(false),
    live_allowed: z.literal(false).default(false),
    /** Min pre-trade EV per paired share, decimal USDC. */
    min_cycle_edge: fraction.default("0.005"),
    pair_size_shares: fraction.default("10"),
    split_gas_usdc: fraction.default("0.02"),
    merge_gas_usdc: fraction.default("0.02"),
    redeem_gas_usdc: fraction.default("0.02"),
    split_latency_ms: z.number().int().min(0).default(2000),
    merge_latency_ms: z.number().int().min(0).default(2000),
    split_failure_fraction: fraction.default("0.02"),
    quote_fill_hazard_per_sec: fraction.default("0.02"),
    opportunity_decay_bps_per_sec: z.number().int().min(0).default(5),
    hedge_policy: z.enum(["auto", "hedge", "cancel"]).default("auto"),
    max_cycles_per_market: z.number().int().min(1).default(1),
    max_open_cycles: z.number().int().min(1).default(2),
    min_seconds_remaining: z.number().int().min(0).default(60),
    rebates_in_pretrade_ev: z.literal(false).default(false),
    rewards_in_pretrade_ev: z.literal(false).default(false),
    /** Liquidity-reward EXPECTED bookkeeping rate, decimal USDC per second. */
    reward_per_second_usdc: fraction.default("0.0001"),
  }).default({}),

  /** Phase 3 inventory/CTF market-making risk limits (@b5p/risk inventory-risk.ts). All hard rejects. */
  inventory_risk: z.object({
    /** Paired/CTF market-making is research-only in this release. Literal so config cannot flip it. */
    live_paired_allowed: z.literal(false).default(false),
    max_unhedged_risk_fraction: fraction.default("0.01"),
    max_one_leg_duration_ms: z.number().int().min(0).default(2000),
    max_attempts_per_intent: z.number().int().min(1).default(1),
    max_cancel_uncertainty_ms: z.number().int().min(0).default(2000),
    /** USDC value of pending (unreconciled) CTF split/merge/redeem operations. */
    max_pending_ctf_value_usdc: fraction.default("50"),
    /** Shares per outcome side (1 share <= 1 USDC worst case). */
    max_outcome_inventory_shares: fraction.default("200"),
    /** UP + DOWN combined. */
    max_gross_paired_inventory_shares: fraction.default("400"),
    max_daily_operational_loss_usdc: fraction.default("20"),
    /** Fraction of bankroll allocatable to SOURCE_REPRODUCTION strategies. */
    max_source_claim_allocation_fraction: fraction.default("0.05"),
    /** Brief invariants: unpaid rebates/rewards never enter pre-trade EV. */
    rebates_in_pretrade_ev: z.literal(false).default(false),
    rewards_in_pretrade_ev: z.literal(false).default(false),
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

/**
 * Strategy versions that reproduce external sources (Reddit analysis /
 * Archetapp gist). Research artifacts by construction: they may run in
 * paper/shadow but a configuration that points LIVE mode at one is invalid.
 * The preset registry enforces the same rule at runtime (allowedModes).
 */
export const SOURCE_REPRODUCTION_STRATEGIES: readonly string[] = [
  "late_snipe_composite_v1",
  "extended_move_fade_v1",
];

/**
 * Paper sizing simulations that encode a SOURCE's aggressive sizing (gist
 * 25%/all-profits/all-in). They exist to demonstrate ruin on simulated money
 * and are valid only under the paper_exploration profile — never alongside a
 * profile that could ever route real or shadow flow.
 */
export const SOURCE_FIXTURE_SIZING_MODES: readonly string[] = [
  "gist_safe",
  "gist_aggressive",
  "gist_degen",
];

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
  const absoluteCap = fractionMillionths(ABSOLUTE_MAX_RISK_FRACTION);
  const pair = cfg.pair;
  const pairFraction = (field: keyof typeof pair): bigint => fractionMillionths(pair[field] as string);
  const pairCapFields = [
    "maximum_cash_fraction",
    "maximum_aggregate_reserved_fraction",
    "maximum_pair_daily_loss_fraction",
    "maximum_pair_session_drawdown_fraction",
  ] as const;
  for (const field of pairCapFields) {
    if (pairFraction(field) > absoluteCap) {
      issues.push({ path: `pair.${field}`, message: `exceeds the absolute safety cap ${ABSOLUTE_MAX_RISK_FRACTION}` });
    }
  }
  if (pairFraction("maximum_residual_loss_fraction") > pairFraction("maximum_cash_fraction")) {
    issues.push({ path: "pair.maximum_residual_loss_fraction", message: "residual loss fraction exceeds pair cash fraction" });
  }
  if (pairFraction("maximum_aggregate_residual_loss_fraction") > pairFraction("maximum_aggregate_reserved_fraction")) {
    issues.push({ path: "pair.maximum_aggregate_residual_loss_fraction", message: "aggregate residual loss fraction exceeds aggregate reserved fraction" });
  }
  if (pairFraction("pair_share_lot") <= 0n) {
    issues.push({ path: "pair.pair_share_lot", message: "pair share lot must be positive" });
  }
  if (pair.maximum_pair_shares !== undefined && fractionMillionths(pair.maximum_pair_shares) < pairFraction("pair_share_lot")) {
    issues.push({ path: "pair.maximum_pair_shares", message: "maximum pair shares must be at least one pair share lot" });
  }
  if (pair.observer_flush_interval_ms > pair.maximum_book_age_ms) {
    issues.push({ path: "pair.observer_flush_interval_ms", message: "observer flush interval exceeds maximum book age" });
  }
  if (pair.activation_quote_ttl_ms > pair.maximum_book_age_ms) {
    issues.push({ path: "pair.activation_quote_ttl_ms", message: "activation quote TTL exceeds maximum book age" });
  }
  if (pair.paper_execution_enabled && !pair.observer_enabled) {
    issues.push({ path: "pair.paper_execution_enabled", message: "paper scheduling requires the observer" });
  }
  const automaticRecovery = pair.recovery_policy !== "NO_AUTO_RECOVERY";
  if (automaticRecovery && !pair.paper_execution_enabled) {
    issues.push({ path: "pair.recovery_policy", message: "automatic recovery requires paper scheduling" });
  }
  if ((!automaticRecovery && pair.maximum_recovery_attempts !== 0) || (automaticRecovery && pair.maximum_recovery_attempts !== 1)) {
    issues.push({ path: "pair.maximum_recovery_attempts", message: automaticRecovery ? "automatic recovery requires exactly one attempt" : "no-auto-recovery requires zero attempts" });
  }
  if (automaticRecovery && pairFraction("recovery_reserve_usdc") === 0n) {
    issues.push({ path: "pair.recovery_reserve_usdc", message: "automatic recovery requires a non-zero cash reserve" });
  }
  if (pair.settlement_policy === "PAPER_VIRTUAL_MERGE" && !pair.paper_execution_enabled) {
    issues.push({ path: "pair.settlement_policy", message: "virtual merge requires paper scheduling" });
  }
  const depthStress = pair.depth_stress_fractions.map(fractionMillionths);
  if (!(depthStress[0]! <= 1_000_000n && depthStress[0]! > depthStress[1]! && depthStress[1]! > depthStress[2]! && depthStress[2]! > 0n)) {
    issues.push({ path: "pair.depth_stress_fractions", message: "depth stress fractions must be strictly descending and within (0, 1]" });
  }
  if (cfg.strategy.candidate_seconds_remaining_min >= cfg.strategy.candidate_seconds_remaining_max) {
    issues.push({ path: "strategy.candidate_seconds_remaining_min", message: "candidate window min must be < max" });
  }
  if (SOURCE_FIXTURE_SIZING_MODES.includes(cfg.paper.sizing_simulation) && cfg.risk.profile !== "paper_exploration") {
    issues.push({
      path: "paper.sizing_simulation",
      message: `source-fixture sizing mode '${cfg.paper.sizing_simulation}' is a paper ruin demonstration; it requires the paper_exploration profile and can never accompany a profile that routes shadow/live flow`,
    });
  }
  if (cfg.app.mode === "live" && SOURCE_REPRODUCTION_STRATEGIES.includes(cfg.strategy.active_version)) {
    issues.push({
      path: "strategy.active_version",
      message: `'${cfg.strategy.active_version}' is a source-reproduction research strategy; it cannot be requested for live mode`,
    });
  }
  if (Number(cfg.inventory_risk.max_unhedged_risk_fraction) > Number(ABSOLUTE_MAX_RISK_FRACTION)) {
    issues.push({
      path: "inventory_risk.max_unhedged_risk_fraction",
      message: `exceeds the absolute safety cap ${ABSOLUTE_MAX_RISK_FRACTION}`,
    });
  }
  if (Number(cfg.inventory_risk.max_source_claim_allocation_fraction) > Number(ABSOLUTE_MAX_RISK_FRACTION)) {
    issues.push({
      path: "inventory_risk.max_source_claim_allocation_fraction",
      message: `unverified source claims can never command more than the absolute cap ${ABSOLUTE_MAX_RISK_FRACTION}`,
    });
  }
  if (cfg.research.promotion.min_net_ev_lower_ci < 0) {
    issues.push({
      path: "research.promotion.min_net_ev_lower_ci",
      message: "promotion net-EV lower-CI bound cannot be below 0; a strategy whose lower CI is negative must never be promoted to live",
    });
  }
  if (Number(cfg.execution_research.paper_variants.stress_missed_fill_fraction) > 1
    || Number(cfg.execution_research.paper_variants.stress_cancel_fail_fraction) > 1) {
    issues.push({ path: "execution_research.paper_variants", message: "stress fractions must be <= 1" });
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

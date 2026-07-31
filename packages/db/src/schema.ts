import {
  bigint, bigserial, boolean, doublePrecision, index, integer, jsonb,
  pgTable, serial, text, uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Conventions:
 *  - *_ms columns are unix epoch milliseconds (bigint).
 *  - *_epoch columns are unix epoch seconds.
 *  - *6 columns are exact micro-units (bigint): micro-USDC, micro-shares, micro-prob.
 *  - *_ppm columns are parts-per-million rates.
 *  - Exact oracle values are stored as their original decimal strings (value_text).
 */

export const markets = pgTable("markets", {
  id: text("id").primaryKey(), // gamma market id
  eventId: text("event_id").notNull(),
  conditionId: text("condition_id").notNull(),
  slug: text("slug").notNull(),
  question: text("question").notNull(),
  upTokenId: text("up_token_id").notNull(),
  downTokenId: text("down_token_id").notNull(),
  startEpoch: bigint("start_epoch", { mode: "number" }).notNull(),
  endEpoch: bigint("end_epoch", { mode: "number" }).notNull(),
  rulesText: text("rules_text").notNull(),
  rulesHash: text("rules_hash").notNull(),
  resolutionSource: text("resolution_source").notNull(),
  rulesNameChainlink: boolean("rules_name_chainlink").notNull(),
  tickSize6: bigint("tick_size6", { mode: "bigint" }).notNull(),
  minOrderShares6: bigint("min_order_shares6", { mode: "bigint" }).notNull(),
  negRisk: boolean("neg_risk").notNull().default(false),
  status: text("status").notNull(), // MarketInstanceState
  outcome: text("outcome"), // UP | DOWN once resolved
  priceToBeatText: text("price_to_beat_text"),      // exact Chainlink value captured at window start
  priceToBeatSource: text("price_to_beat_source"),  // e.g. rtds_chainlink_boundary
  priceToBeatCapturedAtMs: bigint("price_to_beat_captured_at_ms", { mode: "number" }),
  raw: jsonb("raw"),
  discoveredAtMs: bigint("discovered_at_ms", { mode: "number" }).notNull(),
  updatedAtMs: bigint("updated_at_ms", { mode: "number" }).notNull(),
}, (t) => [
  uniqueIndex("markets_slug_idx").on(t.slug),
  index("markets_end_epoch_idx").on(t.endEpoch),
]);

export const marketRuleSnapshots = pgTable("market_rule_snapshots", {
  id: text("id").primaryKey(),
  marketId: text("market_id").notNull().references(() => markets.id),
  rulesText: text("rules_text").notNull(),
  rulesHash: text("rules_hash").notNull(),
  resolutionSource: text("resolution_source").notNull(),
  capturedAtMs: bigint("captured_at_ms", { mode: "number" }).notNull(),
});

export const constraintSnapshots = pgTable("constraint_snapshots", {
  id: text("id").primaryKey(),
  marketId: text("market_id").notNull().references(() => markets.id),
  tickSize6: bigint("tick_size6", { mode: "bigint" }).notNull(),
  minOrderShares6: bigint("min_order_shares6", { mode: "bigint" }).notNull(),
  bestBid6: bigint("best_bid6", { mode: "bigint" }),
  bestAsk6: bigint("best_ask6", { mode: "bigint" }),
  volumeUsd: doublePrecision("volume_usd"),
  capturedAtMs: bigint("captured_at_ms", { mode: "number" }).notNull(),
  raw: jsonb("raw"),
});

export const feeScheduleSnapshots = pgTable("fee_schedule_snapshots", {
  id: text("id").primaryKey(),
  marketId: text("market_id").notNull().references(() => markets.id),
  ratePpm: bigint("rate_ppm", { mode: "bigint" }).notNull(),
  takerOnly: boolean("taker_only").notNull(),
  rebateRatePpm: bigint("rebate_rate_ppm", { mode: "bigint" }).notNull(),
  feeType: text("fee_type"),
  collection: text("collection").notNull(), // usdc | shares
  capturedAtMs: bigint("captured_at_ms", { mode: "number" }).notNull(),
  raw: jsonb("raw"),
});

export const referencePriceTicks = pgTable("reference_price_ticks", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  source: text("source").notNull(), // chainlink | binance
  symbol: text("symbol").notNull(),
  valueText: text("value_text").notNull(),   // exact decimal string
  valueFloat: doublePrecision("value_float").notNull(), // for feature queries only
  sourceTsMs: bigint("source_ts_ms", { mode: "number" }).notNull(),
  receivedTsMs: bigint("received_ts_ms", { mode: "number" }).notNull(),
}, (t) => [
  index("ref_ticks_source_ts_idx").on(t.source, t.sourceTsMs),
]);

export const orderbookSnapshots = pgTable("orderbook_snapshots", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  marketId: text("market_id").notNull(),
  tokenId: text("token_id").notNull(),
  bids: jsonb("bids").notNull(),   // [[price6, size6] as strings], best first
  asks: jsonb("asks").notNull(),
  hash: text("hash"),
  sourceTsMs: bigint("source_ts_ms", { mode: "number" }).notNull(),
  receivedTsMs: bigint("received_ts_ms", { mode: "number" }).notNull(),
}, (t) => [
  index("book_snap_market_ts_idx").on(t.marketId, t.sourceTsMs),
]);

export const marketTradeTicks = pgTable("market_trade_ticks", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  marketId: text("market_id").notNull(),
  tokenId: text("token_id").notNull(),
  price6: bigint("price6", { mode: "bigint" }).notNull(),
  size6: bigint("size6", { mode: "bigint" }).notNull(),
  side: text("side"), // BUY | SELL aggressor when known
  sourceTsMs: bigint("source_ts_ms", { mode: "number" }).notNull(),
  receivedTsMs: bigint("received_ts_ms", { mode: "number" }).notNull(),
}, (t) => [
  index("trade_ticks_market_ts_idx").on(t.marketId, t.sourceTsMs),
]);

export const featureSnapshots = pgTable("feature_snapshots", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  marketId: text("market_id").notNull(),
  tsMs: bigint("ts_ms", { mode: "number" }).notNull(),
  features: jsonb("features").notNull(),
}, (t) => [
  index("feature_snap_market_ts_idx").on(t.marketId, t.tsMs),
]);

export const probabilityEstimates = pgTable("probability_estimates", {
  id: text("id").primaryKey(),
  marketId: text("market_id").notNull(),
  tsMs: bigint("ts_ms", { mode: "number" }).notNull(),
  modelVersion: text("model_version").notNull(),
  probability6: bigint("probability6", { mode: "bigint" }).notNull(),
  lowerBound6: bigint("lower_bound6", { mode: "bigint" }).notNull(),
  upperBound6: bigint("upper_bound6", { mode: "bigint" }).notNull(),
  conservative6: bigint("conservative6", { mode: "bigint" }).notNull(),
  calibrationBucket: text("calibration_bucket").notNull(),
  uncertainty: doublePrecision("uncertainty").notNull(),
  dataQualityPenalty: doublePrecision("data_quality_penalty").notNull(),
  attributions: jsonb("attributions").notNull(),
  approvedForLive: boolean("approved_for_live").notNull().default(false),
});

export const signalCandidates = pgTable("signal_candidates", {
  id: text("id").primaryKey(),
  marketId: text("market_id").notNull(),
  tsMs: bigint("ts_ms", { mode: "number" }).notNull(),
  strategyVersion: text("strategy_version").notNull(),
  side: text("side").notNull(),
  status: text("status").notNull(), // CANDIDATE | REJECTED | RISK_APPROVED | ...
  detail: jsonb("detail").notNull(),
}, (t) => [
  index("signal_candidates_market_idx").on(t.marketId, t.tsMs),
]);

export const decisionSnapshots = pgTable("decision_snapshots", {
  decisionId: text("decision_id").primaryKey(),
  marketId: text("market_id").notNull(),
  mode: text("mode").notNull(),
  correlationId: text("correlation_id").notNull(),
  data: jsonb("data").notNull(), // DecisionSnapshotData
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
}, (t) => [
  index("decision_snapshots_market_idx").on(t.marketId, t.createdAtMs),
]);

export const riskDecisions = pgTable("risk_decisions", {
  id: text("id").primaryKey(),
  decisionId: text("decision_id").notNull().references(() => decisionSnapshots.decisionId),
  approved: boolean("approved").notNull(),
  reasons: jsonb("reasons").notNull(),
  capChain: jsonb("cap_chain").notNull(),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
});

export const orderIntents = pgTable("order_intents", {
  id: text("id").primaryKey(),
  decisionId: text("decision_id").notNull().references(() => decisionSnapshots.decisionId),
  version: integer("version").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  payload: jsonb("payload").notNull(),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
}, (t) => [
  uniqueIndex("order_intents_idem_idx").on(t.idempotencyKey),
]);

export const orders = pgTable("orders", {
  id: text("id").primaryKey(),
  intentId: text("intent_id").notNull().references(() => orderIntents.id),
  decisionId: text("decision_id").notNull(),
  marketId: text("market_id").notNull(),
  tokenId: text("token_id").notNull(),
  outcomeSide: text("outcome_side").notNull(), // UP | DOWN
  orderSide: text("order_side").notNull(),     // BUY | SELL
  style: text("style").notNull(),              // maker_post_only | taker_fok | taker_fak
  timeInForce: text("time_in_force").notNull(),
  postOnly: boolean("post_only").notNull(),
  price6: bigint("price6", { mode: "bigint" }).notNull(),
  shares6: bigint("shares6", { mode: "bigint" }).notNull(),
  filledShares6: bigint("filled_shares6", { mode: "bigint" }).notNull(),
  stake6: bigint("stake6", { mode: "bigint" }).notNull(),
  mode: text("mode").notNull(),
  status: text("status").notNull(),
  statusReason: text("status_reason"),
  expireAtMs: bigint("expire_at_ms", { mode: "number" }),
  externalId: text("external_id"),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
  updatedAtMs: bigint("updated_at_ms", { mode: "number" }).notNull(),
}, (t) => [
  index("orders_market_idx").on(t.marketId),
  index("orders_status_idx").on(t.status),
]);

export const orderFills = pgTable("order_fills", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id),
  price6: bigint("price6", { mode: "bigint" }).notNull(),
  shares6: bigint("shares6", { mode: "bigint" }).notNull(),
  feeUsdc6: bigint("fee_usdc6", { mode: "bigint" }).notNull(),
  maker: boolean("maker").notNull(),
  tradeRef: text("trade_ref"),
  tsMs: bigint("ts_ms", { mode: "number" }).notNull(),
});

export const positions = pgTable("positions", {
  id: text("id").primaryKey(),
  marketId: text("market_id").notNull(),
  decisionId: text("decision_id"),
  mode: text("mode").notNull(),
  outcomeSide: text("outcome_side").notNull(),
  shares6: bigint("shares6", { mode: "bigint" }).notNull(),
  avgPrice6: bigint("avg_price6", { mode: "bigint" }).notNull(),
  cost6: bigint("cost6", { mode: "bigint" }).notNull(),
  stake6: bigint("stake6", { mode: "bigint" }).notNull(),
  exitPolicy: text("exit_policy").notNull(),
  status: text("status").notNull(), // OPEN | RESOLVED
  outcome: text("outcome"),
  pnl6: bigint("pnl6", { mode: "bigint" }),
  openedAtMs: bigint("opened_at_ms", { mode: "number" }).notNull(),
  resolvedAtMs: bigint("resolved_at_ms", { mode: "number" }),
}, (t) => [
  index("positions_market_idx").on(t.marketId),
  index("positions_status_idx").on(t.status),
]);

export const resolutions = pgTable("resolutions", {
  id: text("id").primaryKey(),
  marketId: text("market_id").notNull(),
  outcome: text("outcome").notNull(),             // engine-computed UP | DOWN
  priceToBeatText: text("price_to_beat_text"),
  finalValueText: text("final_value_text"),
  officialOutcome: text("official_outcome"),      // from gamma once available
  mismatch: boolean("mismatch").notNull().default(false),
  source: text("source").notNull(),
  resolvedAtMs: bigint("resolved_at_ms", { mode: "number" }).notNull(),
}, (t) => [
  uniqueIndex("resolutions_market_idx").on(t.marketId),
]);

export const pnlRecords = pgTable("pnl_records", {
  id: text("id").primaryKey(),
  mode: text("mode").notNull(),
  marketId: text("market_id").notNull(),
  positionId: text("position_id"),
  gross6: bigint("gross6", { mode: "bigint" }).notNull(),
  fees6: bigint("fees6", { mode: "bigint" }).notNull(),
  rebates6: bigint("rebates6", { mode: "bigint" }).notNull(),
  net6: bigint("net6", { mode: "bigint" }).notNull(),
  meta: jsonb("meta"),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
}, (t) => [
  index("pnl_records_mode_idx").on(t.mode, t.createdAtMs),
]);

export const bankrollSnapshots = pgTable("bankroll_snapshots", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  mode: text("mode").notNull(),
  bankroll6: bigint("bankroll6", { mode: "bigint" }).notNull(),
  basis: text("basis").notNull(),
  tsMs: bigint("ts_ms", { mode: "number" }).notNull(),
});

export const tradingSessions = pgTable("trading_sessions", {
  id: text("id").primaryKey(),
  mode: text("mode").notNull(),
  startedAtMs: bigint("started_at_ms", { mode: "number" }).notNull(),
  endedAtMs: bigint("ended_at_ms", { mode: "number" }),
  startingBankroll6: bigint("starting_bankroll6", { mode: "bigint" }).notNull(),
  peakBankroll6: bigint("peak_bankroll6", { mode: "bigint" }).notNull(),
  realized6: bigint("realized6", { mode: "bigint" }).notNull(),
  consecutiveLosses: integer("consecutive_losses").notNull().default(0),
  stoppedReason: text("stopped_reason"),
});

export const killSwitchEvents = pgTable("kill_switch_events", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(),
  reason: text("reason").notNull(),
  actor: text("actor").notNull(),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
});

export const healthEvents = pgTable("health_events", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  kind: text("kind").notNull(),
  severity: text("severity").notNull(), // info | warning | critical
  message: text("message").notNull(),
  data: jsonb("data"),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
}, (t) => [
  index("health_events_ts_idx").on(t.createdAtMs),
]);

export const configVersions = pgTable("config_versions", {
  version: serial("version").primaryKey(),
  config: jsonb("config").notNull(),
  changedPaths: jsonb("changed_paths"),
  actor: text("actor").notNull(),
  active: boolean("active").notNull().default(false),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
});

export const auditEvents = pgTable("audit_events", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  category: text("category").notNull(),
  action: text("action").notNull(),
  actor: text("actor").notNull(),
  correlationId: text("correlation_id"),
  data: jsonb("data"),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
}, (t) => [
  index("audit_events_ts_idx").on(t.createdAtMs),
]);

export const engineKv = pgTable("engine_kv", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAtMs: bigint("updated_at_ms", { mode: "number" }).notNull(),
});

/** Resolved-market history backfilled from Gamma for the Timing Lab. */
export const researchMarkets = pgTable("research_markets", {
  id: text("id").primaryKey(), // gamma market id
  slug: text("slug").notNull(),
  startEpoch: bigint("start_epoch", { mode: "number" }).notNull(),
  endEpoch: bigint("end_epoch", { mode: "number" }).notNull(),
  outcome: text("outcome").notNull(), // UP | DOWN
  volumeUsd: doublePrecision("volume_usd"),
  priceToBeat: doublePrecision("price_to_beat"),
  raw: jsonb("raw"),
  ingestedAtMs: bigint("ingested_at_ms", { mode: "number" }).notNull(),
}, (t) => [
  uniqueIndex("research_markets_slug_idx").on(t.slug),
  index("research_markets_end_idx").on(t.endEpoch),
]);

export const timingBucketStatistics = pgTable("timing_bucket_statistics", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  source: text("source").notNull(), // seed | gamma
  windowDays: integer("window_days").notNull(),
  bucket: text("bucket").notNull(), // 00..55 | quarter | other | all
  n: integer("n").notNull(),
  up: integer("up").notNull(),
  upRate: doublePrecision("up_rate").notNull(),
  wilsonLo: doublePrecision("wilson_lo").notNull(),
  wilsonHi: doublePrecision("wilson_hi").notNull(),
  pRaw: doublePrecision("p_raw"),
  pBonferroni: doublePrecision("p_bonferroni"),
  pBh: doublePrecision("p_bh"),
  medianAbsMoveBps: doublePrecision("median_abs_move_bps"),
  meanAbsMoveBps: doublePrecision("mean_abs_move_bps"),
  p90AbsMoveBps: doublePrecision("p90_abs_move_bps"),
  medianVolume: doublePrecision("median_volume"),
  meta: jsonb("meta"),
  computedAtMs: bigint("computed_at_ms", { mode: "number" }).notNull(),
}, (t) => [
  index("timing_stats_run_idx").on(t.runId),
]);

export const backtestRuns = pgTable("backtest_runs", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(), // backtest | replay | calibration
  params: jsonb("params").notNull(),
  status: text("status").notNull(),
  result: jsonb("result"),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
  finishedAtMs: bigint("finished_at_ms", { mode: "number" }),
});

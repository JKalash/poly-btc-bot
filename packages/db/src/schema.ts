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

// ---------- evidence / provenance (refinement brief) ----------

export const sourceEvidence = pgTable("source_evidence", {
  id: text("id").primaryKey(),
  sourceKey: text("source_key").notNull(),
  claimKey: text("claim_key").notNull(),
  title: text("title").notNull(),
  claimText: text("claim_text").notNull(),
  claimedValue: text("claimed_value"),
  units: text("units"),
  label: text("label").notNull(), // EvidenceLabel
  url: text("url"),
  retrievedAtMs: bigint("retrieved_at_ms", { mode: "number" }),
  reproducedValue: text("reproduced_value"),
  reproductionRunId: text("reproduction_run_id"),
  methodologyNotes: text("methodology_notes"),
  correlationId: text("correlation_id").notNull(),
  configVersion: integer("config_version"),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
  updatedAtMs: bigint("updated_at_ms", { mode: "number" }).notNull(),
}, (t) => [
  uniqueIndex("source_evidence_claim_idx").on(t.sourceKey, t.claimKey),
  index("source_evidence_label_idx").on(t.label),
]);

export const datasetManifests = pgTable("dataset_manifests", {
  id: text("id").primaryKey(),
  datasetKey: text("dataset_key").notNull(),
  title: text("title").notNull(),
  source: text("source").notNull(),
  license: text("license"),
  files: jsonb("files").notNull(), // DatasetFileEntry[]
  contentChecksum: text("content_checksum").notNull(),
  timeRangeStartMs: bigint("time_range_start_ms", { mode: "number" }),
  timeRangeEndMs: bigint("time_range_end_ms", { mode: "number" }),
  rowCount: bigint("row_count", { mode: "number" }),
  schemaDescription: text("schema_description"),
  materialized: boolean("materialized").notNull().default(false),
  retrievedAtMs: bigint("retrieved_at_ms", { mode: "number" }),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
}, (t) => [
  index("dataset_manifests_key_idx").on(t.datasetKey),
]);

// ---------- reproducible experiments ----------

export const experimentDefinitions = pgTable("experiment_definitions", {
  id: text("id").primaryKey(),
  experimentKey: text("experiment_key").notNull(),
  title: text("title").notNull(),
  hypothesis: text("hypothesis").notNull(),
  nullHypothesis: text("null_hypothesis").notNull(),
  primaryMetric: text("primary_metric").notNull(),
  successCriteria: text("success_criteria").notNull(),
  sourceEvidenceIds: jsonb("source_evidence_ids").notNull(), // string[]
  datasetKeys: jsonb("dataset_keys").notNull(),              // string[]
  foldPlan: jsonb("fold_plan"),                              // FoldPlan | null
  status: text("status").notNull(),                          // HypothesisStatus
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
  updatedAtMs: bigint("updated_at_ms", { mode: "number" }).notNull(),
}, (t) => [
  uniqueIndex("experiment_definitions_key_idx").on(t.experimentKey),
]);

export const experimentRuns = pgTable("experiment_runs", {
  id: text("id").primaryKey(),
  definitionId: text("definition_id").notNull().references(() => experimentDefinitions.id),
  runKey: text("run_key").notNull(),
  params: jsonb("params").notNull(),
  datasetManifestIds: jsonb("dataset_manifest_ids").notNull(), // string[]
  codeVersion: text("code_version").notNull(),
  configVersion: integer("config_version"),
  status: text("status").notNull(), // RUNNING | COMPLETED | FAILED
  startedAtMs: bigint("started_at_ms", { mode: "number" }).notNull(),
  finishedAtMs: bigint("finished_at_ms", { mode: "number" }),
  resultSummary: jsonb("result_summary"),
  resultChecksum: text("result_checksum"),
  correlationId: text("correlation_id").notNull(),
}, (t) => [
  index("experiment_runs_definition_idx").on(t.definitionId),
]);

export const experimentObservations = pgTable("experiment_observations", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => experimentRuns.id),
  metric: text("metric").notNull(),
  scope: text("scope").notNull(), // "overall" | fold id | bucket | ...
  value: doublePrecision("value"),
  valueText: text("value_text"), // exact value when doubles would lose precision
  n: integer("n"),
  ciLo: doublePrecision("ci_lo"),
  ciHi: doublePrecision("ci_hi"),
  detail: jsonb("detail"),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
}, (t) => [
  index("experiment_observations_run_idx").on(t.runId, t.metric),
]);

// ---------- model / calibration artifacts + promotion ----------

export const modelArtifacts = pgTable("model_artifacts", {
  id: text("id").primaryKey(),
  modelKey: text("model_key").notNull(),
  version: text("version").notNull(),
  kind: text("kind").notNull(), // logistic | gbm
  featureNames: jsonb("feature_names").notNull(),
  coefficients: jsonb("coefficients"),
  standardization: jsonb("standardization"),
  datasetManifestIds: jsonb("dataset_manifest_ids").notNull(),
  foldPlan: jsonb("fold_plan").notNull(),
  trainedAtMs: bigint("trained_at_ms", { mode: "number" }).notNull(),
  codeVersion: text("code_version").notNull(),
  artifactChecksum: text("artifact_checksum").notNull(),
  artifact: jsonb("artifact").notNull(), // full payload for audit/reload
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
}, (t) => [
  uniqueIndex("model_artifacts_version_idx").on(t.version),
]);

export const calibrationArtifacts = pgTable("calibration_artifacts", {
  id: text("id").primaryKey(),
  modelArtifactId: text("model_artifact_id").notNull().references(() => modelArtifacts.id),
  method: text("method").notNull(), // isotonic | platt
  curve: jsonb("curve"),
  platt: jsonb("platt"),
  metrics: jsonb("metrics").notNull(),          // CalibrationMetrics (out-of-fold)
  perFoldMetrics: jsonb("per_fold_metrics").notNull(),
  codeVersion: text("code_version").notNull(),
  artifactChecksum: text("artifact_checksum").notNull(),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
}, (t) => [
  index("calibration_artifacts_model_idx").on(t.modelArtifactId),
]);

export const strategyPromotionDecisions = pgTable("strategy_promotion_decisions", {
  id: text("id").primaryKey(),
  strategyVersion: text("strategy_version").notNull(),
  modelVersion: text("model_version").notNull(),
  mode: text("mode").notNull(), // paper | shadow | live
  approved: boolean("approved").notNull(),
  reasons: jsonb("reasons").notNull(),   // string[]
  evidence: jsonb("evidence").notNull(), // PromotionEvidence
  criteria: jsonb("criteria").notNull(), // PromotionCriteria
  calibrationArtifactId: text("calibration_artifact_id"),
  decidedBy: text("decided_by").notNull(),
  decidedAtMs: bigint("decided_at_ms", { mode: "number" }).notNull(),
  active: boolean("active").notNull().default(false),
}, (t) => [
  index("strategy_promotion_idx").on(t.strategyVersion, t.mode, t.active),
]);

// ---------- execution-quality timeline (refinement plan item 1b) ----------
// Domain contracts live in @b5p/domain/src/execution.ts. mode = PAPER|SHADOW|LIVE.
// NOTE: pnl_records semantics are UNCHANGED (they remain the QUEUE_REPLAY paper
// path); additional paper-fill variants land in paper_variant_results.

export const executionTimelineEvents = pgTable("execution_timeline_events", {
  id: text("id").primaryKey(), // stable event id: duplicate deliveries upsert, never double-count
  correlationId: text("correlation_id").notNull(),
  // Pre-generated intent id; deliberately NOT an FK — the DECISION_SNAPSHOT
  // event is written before the order_intents row exists.
  intentId: text("intent_id").notNull(),
  attemptId: text("attempt_id"),
  state: text("state").notNull(), // ExecutionTimelineState
  tsMs: bigint("ts_ms", { mode: "number" }).notNull(),
  monoNs: bigint("mono_ns", { mode: "bigint" }), // process-local monotonic clock, ns
  bookSnapshotId: bigint("book_snapshot_id", { mode: "bigint" }).references(() => orderbookSnapshots.id),
  mode: text("mode").notNull(), // PAPER | SHADOW | LIVE
  detail: jsonb("detail"),
  configVersion: integer("config_version").notNull(),
}, (t) => [
  index("exec_timeline_correlation_idx").on(t.correlationId, t.tsMs),
  index("exec_timeline_intent_idx").on(t.intentId, t.tsMs),
]);

export const orderAttempts = pgTable("order_attempts", {
  id: text("id").primaryKey(),
  intentId: text("intent_id").notNull().references(() => orderIntents.id),
  correlationId: text("correlation_id").notNull(),
  attemptNumber: integer("attempt_number").notNull(), // starts at 1; retry after reconcile = new attempt
  requestHash: text("request_hash").notNull(),        // hash of exact signed request payload
  tokenId: text("token_id").notNull(),
  side: text("side").notNull(), // BUY | SELL
  price6: bigint("price6", { mode: "bigint" }).notNull(),
  size6: bigint("size6", { mode: "bigint" }).notNull(),
  remaining6: bigint("remaining6", { mode: "bigint" }).notNull(),
  timeInForce: text("time_in_force").notNull(),
  postOnly: boolean("post_only").notNull(),
  status: text("status").notNull(), // latest ExecutionTimelineState
  decisionBookSnapshotId: bigint("decision_book_snapshot_id", { mode: "bigint" }).references(() => orderbookSnapshots.id),
  sendBookSnapshotId: bigint("send_book_snapshot_id", { mode: "bigint" }).references(() => orderbookSnapshots.id),
  ackBookSnapshotId: bigint("ack_book_snapshot_id", { mode: "bigint" }).references(() => orderbookSnapshots.id),
  fillBookSnapshotId: bigint("fill_book_snapshot_id", { mode: "bigint" }).references(() => orderbookSnapshots.id),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
  updatedAtMs: bigint("updated_at_ms", { mode: "number" }).notNull(),
  configVersion: integer("config_version").notNull(),
}, (t) => [
  uniqueIndex("order_attempts_intent_attempt_idx").on(t.intentId, t.attemptNumber),
  index("order_attempts_correlation_idx").on(t.correlationId),
  index("order_attempts_status_idx").on(t.status),
]);

export const latencySamples = pgTable("latency_samples", {
  id: text("id").primaryKey(),
  correlationId: text("correlation_id").notNull(),
  intentId: text("intent_id"),
  attemptId: text("attempt_id"),
  stage: text("stage").notNull(), // SIGN | SEND | ACK | CANCEL | BOOK_FEED
  durationUs: bigint("duration_us", { mode: "number" }).notNull(), // microseconds
  mode: text("mode").notNull(), // PAPER | SHADOW | LIVE
  tsMs: bigint("ts_ms", { mode: "number" }).notNull(),
  configVersion: integer("config_version").notNull(),
}, (t) => [
  index("latency_samples_stage_ts_idx").on(t.stage, t.tsMs),
  index("latency_samples_correlation_idx").on(t.correlationId),
]);

export const queueEstimates = pgTable("queue_estimates", {
  id: text("id").primaryKey(),
  correlationId: text("correlation_id").notNull(),
  attemptId: text("attempt_id").notNull().references(() => orderAttempts.id),
  tokenId: text("token_id").notNull(),
  price6: bigint("price6", { mode: "bigint" }).notNull(),
  aheadShares6: bigint("ahead_shares6", { mode: "bigint" }).notNull(),
  method: text("method").notNull(), // BOOK_DELTA_FIFO | TRADE_TAPE_REPLAY | FULL_LEVEL_CONSERVATIVE
  tsMs: bigint("ts_ms", { mode: "number" }).notNull(),
  configVersion: integer("config_version").notNull(),
}, (t) => [
  index("queue_estimates_attempt_ts_idx").on(t.attemptId, t.tsMs),
  index("queue_estimates_correlation_idx").on(t.correlationId),
]);

export const fillCounterfactuals = pgTable("fill_counterfactuals", {
  id: text("id").primaryKey(),
  correlationId: text("correlation_id").notNull(),
  decisionId: text("decision_id").notNull(),
  marketId: text("market_id").notNull(),
  tokenId: text("token_id").notNull(),
  price6: bigint("price6", { mode: "bigint" }).notNull(),
  size6: bigint("size6", { mode: "bigint" }).notNull(),
  wouldFill: boolean("would_fill").notNull(),
  reason: text("reason").notNull(),
  evidence: jsonb("evidence").notNull(), // book/trade refs supporting the counterfactual
  tsMs: bigint("ts_ms", { mode: "number" }).notNull(),
  configVersion: integer("config_version").notNull(),
}, (t) => [
  index("fill_counterfactuals_market_ts_idx").on(t.marketId, t.tsMs),
  index("fill_counterfactuals_correlation_idx").on(t.correlationId),
]);

export const markoutObservations = pgTable("markout_observations", {
  id: text("id").primaryKey(),
  correlationId: text("correlation_id").notNull(),
  attemptId: text("attempt_id"),
  fillId: text("fill_id"), // order_fills id when tied to a specific fill
  marketId: text("market_id").notNull(),
  tokenId: text("token_id").notNull(),
  side: text("side").notNull(), // BUY | SELL (markout6 is side-adjusted)
  horizonMs: text("horizon_ms").notNull(), // "250"|"1000"|"2000"|"5000"|"10000"|"30000"|"AT_RESOLUTION"
  midAtFill6: bigint("mid_at_fill6", { mode: "bigint" }).notNull(),
  midAtHorizon6: bigint("mid_at_horizon6", { mode: "bigint" }).notNull(),
  markout6: bigint("markout6", { mode: "bigint" }).notNull(), // signed; positive = moved in our favor
  tsMs: bigint("ts_ms", { mode: "number" }).notNull(),
  configVersion: integer("config_version").notNull(),
}, (t) => [
  index("markout_obs_market_ts_idx").on(t.marketId, t.tsMs),
  index("markout_obs_correlation_idx").on(t.correlationId),
]);

export const paperVariantResults = pgTable("paper_variant_results", {
  id: text("id").primaryKey(),
  correlationId: text("correlation_id").notNull(),
  decisionId: text("decision_id").notNull(),
  marketId: text("market_id").notNull(),
  variant: text("variant").notNull(), // OPTIMISTIC_TOUCH | QUEUE_REPLAY | CONSERVATIVE_STRESS
  filled: boolean("filled").notNull(),
  fillPrice6: bigint("fill_price6", { mode: "bigint" }).notNull(), // 0 when not filled
  fillSize6: bigint("fill_size6", { mode: "bigint" }).notNull(),   // 0 when not filled
  fee6: bigint("fee6", { mode: "bigint" }).notNull(),
  pnl6: bigint("pnl6", { mode: "bigint" }), // null until resolution
  detail: jsonb("detail"),
  tsMs: bigint("ts_ms", { mode: "number" }).notNull(),
  configVersion: integer("config_version").notNull(),
}, (t) => [
  uniqueIndex("paper_variant_decision_variant_idx").on(t.decisionId, t.variant),
  index("paper_variant_market_ts_idx").on(t.marketId, t.tsMs),
  index("paper_variant_correlation_idx").on(t.correlationId),
]);

export const fillSelectionCostRecords = pgTable("fill_selection_cost_records", {
  id: text("id").primaryKey(),
  correlationId: text("correlation_id").notNull(),
  marketId: text("market_id"), // null = aggregate across markets in the window
  signalConditionedValue6: bigint("signal_conditioned_value6", { mode: "bigint" }).notNull(),
  fillConditionedValue6: bigint("fill_conditioned_value6", { mode: "bigint" }).notNull(),
  cost6: bigint("cost6", { mode: "bigint" }).notNull(), // signal - fill; positive = adverse selection
  signalSampleCount: integer("signal_sample_count").notNull(),
  fillSampleCount: integer("fill_sample_count").notNull(),
  windowStartMs: bigint("window_start_ms", { mode: "number" }).notNull(),
  windowEndMs: bigint("window_end_ms", { mode: "number" }).notNull(),
  tsMs: bigint("ts_ms", { mode: "number" }).notNull(),
  configVersion: integer("config_version").notNull(),
}, (t) => [
  index("fill_selection_cost_ts_idx").on(t.tsMs),
  index("fill_selection_cost_market_idx").on(t.marketId, t.tsMs),
]);

// ---------- CTF / inventory market-making spine (Phase 3, R10 + R12) ----------
// Domain contracts live in @b5p/domain/src/inventory.ts. Paper/shadow only by
// policy; mode columns are PAPER | SHADOW | LIVE (ExecutionMode).
// Accrual tables flatten the domain AccrualStatus union: the invariant
// realized === (state = 'PAID') is enforced in domain code + tests
// (drizzle-kit 0.30 has no CHECK support); writers must keep it.

export const pairedQuoteCycles = pgTable("paired_quote_cycles", {
  id: text("id").primaryKey(),
  correlationId: text("correlation_id").notNull(),
  marketId: text("market_id").notNull(),
  mode: text("mode").notNull(), // PAPER | SHADOW | LIVE (risk-gated to paper/shadow)
  kind: text("kind").notNull(), // SPLIT_SELL | BUY_BOTH_MERGE
  state: text("state").notNull(), // PairedCycleState
  targetPairPrice6: bigint("target_pair_price6", { mode: "bigint" }).notNull(), // up+down quote sum
  collateralCommitted6: bigint("collateral_committed6", { mode: "bigint" }).notNull(),
  worstCaseLoss6: bigint("worst_case_loss6", { mode: "bigint" }).notNull(), // planned failure-path loss
  // ctf_operations ids; plain refs (set by UPDATE after the op row is inserted), deliberately no FK
  splitOperationId: text("split_operation_id"),
  mergeOperationId: text("merge_operation_id"),
  oneLegFilledAtMs: bigint("one_leg_filled_at_ms", { mode: "number" }),
  hedgeCompletedAtMs: bigint("hedge_completed_at_ms", { mode: "number" }),
  unhedgedDurationMs: bigint("unhedged_duration_ms", { mode: "number" }),
  spreadCaptured6: bigint("spread_captured6", { mode: "bigint" }),
  fees6: bigint("fees6", { mode: "bigint" }),
  realizedPnl6: bigint("realized_pnl6", { mode: "bigint" }), // trades only; NEVER unpaid accruals
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
  updatedAtMs: bigint("updated_at_ms", { mode: "number" }).notNull(),
  reconciledAtMs: bigint("reconciled_at_ms", { mode: "number" }),
  configVersion: integer("config_version").notNull(),
}, (t) => [
  index("paired_cycles_market_idx").on(t.marketId, t.createdAtMs),
  index("paired_cycles_state_idx").on(t.state),
  index("paired_cycles_correlation_idx").on(t.correlationId),
]);

export const pairedLegs = pgTable("paired_legs", {
  id: text("id").primaryKey(),
  correlationId: text("correlation_id").notNull(),
  cycleId: text("cycle_id").notNull().references(() => pairedQuoteCycles.id), // legs never precede their cycle
  marketId: text("market_id").notNull(),
  tokenId: text("token_id").notNull(),
  outcomeSide: text("outcome_side").notNull(), // UP | DOWN
  orderSide: text("order_side").notNull(),     // SELL (split-sell) | BUY (buy-both-merge)
  state: text("state").notNull(),              // PairedLegState (incl. PARTIAL_LEG, UNHEDGED)
  price6: bigint("price6", { mode: "bigint" }).notNull(),
  size6: bigint("size6", { mode: "bigint" }).notNull(),
  filledShares6: bigint("filled_shares6", { mode: "bigint" }).notNull(), // writers supply 0 explicitly
  avgFillPrice6: bigint("avg_fill_price6", { mode: "bigint" }),
  feeUsdc6: bigint("fee_usdc6", { mode: "bigint" }),
  // order_attempts id; deliberately no FK — shadow legs have no attempt rows
  attemptId: text("attempt_id"),
  quotedAtMs: bigint("quoted_at_ms", { mode: "number" }),
  firstFillAtMs: bigint("first_fill_at_ms", { mode: "number" }),
  unhedgedStartedAtMs: bigint("unhedged_started_at_ms", { mode: "number" }),
  hedgedAtMs: bigint("hedged_at_ms", { mode: "number" }),
  closedAtMs: bigint("closed_at_ms", { mode: "number" }),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
  updatedAtMs: bigint("updated_at_ms", { mode: "number" }).notNull(),
  configVersion: integer("config_version").notNull(),
}, (t) => [
  index("paired_legs_cycle_idx").on(t.cycleId),
  index("paired_legs_state_idx").on(t.state),
  index("paired_legs_market_idx").on(t.marketId, t.createdAtMs),
]);

export const ctfOperations = pgTable("ctf_operations", {
  id: text("id").primaryKey(),
  correlationId: text("correlation_id").notNull(),
  cycleId: text("cycle_id").references(() => pairedQuoteCycles.id), // null = standalone inventory op
  marketId: text("market_id").notNull(),
  conditionId: text("condition_id").notNull(),
  kind: text("kind").notNull(),   // SPLIT | MERGE | REDEEM
  state: text("state").notNull(), // CtfOperationState
  mode: text("mode").notNull(),
  requestedAmount6: bigint("requested_amount6", { mode: "bigint" }).notNull(), // micro paired-units
  confirmedAmount6: bigint("confirmed_amount6", { mode: "bigint" }),           // partial modeling
  collateralDelta6: bigint("collateral_delta6", { mode: "bigint" }),           // signed: SPLIT -, MERGE/REDEEM +
  estGasUsdc6: bigint("est_gas_usdc6", { mode: "bigint" }),
  actualGasUsdc6: bigint("actual_gas_usdc6", { mode: "bigint" }),
  relayed: boolean("relayed").notNull(),
  txHash: text("tx_hash"),
  failureReason: text("failure_reason"),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
  submittedAtMs: bigint("submitted_at_ms", { mode: "number" }),
  confirmedAtMs: bigint("confirmed_at_ms", { mode: "number" }),
  updatedAtMs: bigint("updated_at_ms", { mode: "number" }).notNull(),
  configVersion: integer("config_version").notNull(),
}, (t) => [
  index("ctf_ops_cycle_idx").on(t.cycleId),
  index("ctf_ops_market_idx").on(t.marketId, t.createdAtMs),
  index("ctf_ops_state_idx").on(t.state),
]);

export const hedgeActions = pgTable("hedge_actions", {
  id: text("id").primaryKey(),
  correlationId: text("correlation_id").notNull(),
  cycleId: text("cycle_id").notNull().references(() => pairedQuoteCycles.id),
  legId: text("leg_id").references(() => pairedLegs.id), // null = cycle-level action
  marketId: text("market_id").notNull(),
  tokenId: text("token_id"),
  kind: text("kind").notNull(),   // COMPLETE_PAIR_TAKER | DUMP_SURVIVOR_TAKER | CANCEL_REMAINING_QUOTE | HOLD_TO_RESOLUTION
  state: text("state").notNull(), // PLANNED | EXECUTING | DONE | FAILED
  mode: text("mode").notNull(),
  targetShares6: bigint("target_shares6", { mode: "bigint" }).notNull(),
  executedShares6: bigint("executed_shares6", { mode: "bigint" }),
  expectedCost6: bigint("expected_cost6", { mode: "bigint" }),
  actualCost6: bigint("actual_cost6", { mode: "bigint" }),
  feeUsdc6: bigint("fee_usdc6", { mode: "bigint" }),
  attemptId: text("attempt_id"), // order_attempts id; no FK (may be absent in shadow)
  unhedgedDurationMs: bigint("unhedged_duration_ms", { mode: "number" }),
  decidedAtMs: bigint("decided_at_ms", { mode: "number" }).notNull(),
  executedAtMs: bigint("executed_at_ms", { mode: "number" }),
  updatedAtMs: bigint("updated_at_ms", { mode: "number" }).notNull(),
  configVersion: integer("config_version").notNull(),
}, (t) => [
  index("hedge_actions_cycle_idx").on(t.cycleId),
  index("hedge_actions_leg_idx").on(t.legId),
  index("hedge_actions_decided_idx").on(t.decidedAtMs),
]);

export const inventoryLots = pgTable("inventory_lots", {
  id: text("id").primaryKey(),
  correlationId: text("correlation_id").notNull(),
  cycleId: text("cycle_id").references(() => pairedQuoteCycles.id),
  marketId: text("market_id").notNull(),
  tokenId: text("token_id").notNull(),
  outcomeSide: text("outcome_side").notNull(), // UP | DOWN
  source: text("source").notNull(),            // SPLIT | FILL | HEDGE | TRANSFER_IN
  sourceRef: text("source_ref"),               // ctf_operations id / order_fills id / tx hash
  mode: text("mode").notNull(),
  acquiredShares6: bigint("acquired_shares6", { mode: "bigint" }).notNull(),
  remainingShares6: bigint("remaining_shares6", { mode: "bigint" }).notNull(), // 0 = consumed
  costBasis6: bigint("cost_basis6", { mode: "bigint" }).notNull(),             // micro-USDC, whole lot
  acquiredAtMs: bigint("acquired_at_ms", { mode: "number" }).notNull(),
  consumedAtMs: bigint("consumed_at_ms", { mode: "number" }),
  configVersion: integer("config_version").notNull(),
}, (t) => [
  index("inventory_lots_token_idx").on(t.tokenId, t.acquiredAtMs),
  index("inventory_lots_market_idx").on(t.marketId),
  index("inventory_lots_cycle_idx").on(t.cycleId),
]);

export const inventorySnapshots = pgTable("inventory_snapshots", {
  id: text("id").primaryKey(),
  correlationId: text("correlation_id").notNull(),
  marketId: text("market_id").notNull(),
  mode: text("mode").notNull(),
  upShares6: bigint("up_shares6", { mode: "bigint" }).notNull(),
  downShares6: bigint("down_shares6", { mode: "bigint" }).notNull(),
  pairedShares6: bigint("paired_shares6", { mode: "bigint" }).notNull(),
  unpairedUpShares6: bigint("unpaired_up_shares6", { mode: "bigint" }).notNull(),
  unpairedDownShares6: bigint("unpaired_down_shares6", { mode: "bigint" }).notNull(),
  reservedUpShares6: bigint("reserved_up_shares6", { mode: "bigint" }).notNull(),   // locked in open quotes
  reservedDownShares6: bigint("reserved_down_shares6", { mode: "bigint" }).notNull(),
  collateralFree6: bigint("collateral_free6", { mode: "bigint" }),
  exchangeUpShares6: bigint("exchange_up_shares6", { mode: "bigint" }),
  exchangeDownShares6: bigint("exchange_down_shares6", { mode: "bigint" }),
  onchainUpShares6: bigint("onchain_up_shares6", { mode: "bigint" }),
  onchainDownShares6: bigint("onchain_down_shares6", { mode: "bigint" }),
  reconciled: boolean("reconciled").notNull(),
  divergence: jsonb("divergence"),
  tsMs: bigint("ts_ms", { mode: "number" }).notNull(),
  configVersion: integer("config_version").notNull(),
}, (t) => [
  index("inventory_snapshots_market_ts_idx").on(t.marketId, t.tsMs),
  index("inventory_snapshots_mode_ts_idx").on(t.mode, t.tsMs),
]);

export const rebateAccruals = pgTable("rebate_accruals", {
  id: text("id").primaryKey(),
  correlationId: text("correlation_id").notNull(),
  programVersion: text("program_version").notNull(), // versioned MAKER_REBATE program rules
  marketId: text("market_id").notNull(),
  cycleId: text("cycle_id").references(() => pairedQuoteCycles.id),
  fillId: text("fill_id"), // order_fills id; unique when set (no double rebate per fill)
  basisShares6: bigint("basis_shares6", { mode: "bigint" }),
  basisNotional6: bigint("basis_notional6", { mode: "bigint" }),
  amount6: bigint("amount6", { mode: "bigint" }).notNull(), // best estimate; NOT realized until PAID
  state: text("state").notNull(),        // EXPECTED | ACCRUED | PENDING | PAID | DISPUTED
  realized: boolean("realized").notNull(), // invariant: true iff state = PAID
  paidAmount6: bigint("paid_amount6", { mode: "bigint" }), // null until PAID
  paidAtMs: bigint("paid_at_ms", { mode: "number" }),      // null until PAID
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
  updatedAtMs: bigint("updated_at_ms", { mode: "number" }).notNull(),
  configVersion: integer("config_version").notNull(),
}, (t) => [
  uniqueIndex("rebate_accruals_fill_idx").on(t.fillId), // NULLs distinct; non-null fill ids unique
  index("rebate_accruals_state_idx").on(t.state),
  index("rebate_accruals_market_idx").on(t.marketId, t.createdAtMs),
  index("rebate_accruals_cycle_idx").on(t.cycleId),
]);

export const liquidityRewardAccruals = pgTable("liquidity_reward_accruals", {
  id: text("id").primaryKey(),
  correlationId: text("correlation_id").notNull(),
  programVersion: text("program_version").notNull(), // versioned LIQUIDITY_REWARD program rules
  marketId: text("market_id"), // null = epoch-level reward not attributable to one market
  epochKey: text("epoch_key").notNull(),
  qualifyingUptimeMs: bigint("qualifying_uptime_ms", { mode: "number" }),
  scoreDetail: jsonb("score_detail"),
  amount6: bigint("amount6", { mode: "bigint" }).notNull(), // best estimate; NOT realized until PAID
  state: text("state").notNull(),
  realized: boolean("realized").notNull(), // invariant: true iff state = PAID
  paidAmount6: bigint("paid_amount6", { mode: "bigint" }),
  paidAtMs: bigint("paid_at_ms", { mode: "number" }),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
  updatedAtMs: bigint("updated_at_ms", { mode: "number" }).notNull(),
  configVersion: integer("config_version").notNull(),
}, (t) => [
  uniqueIndex("liquidity_reward_epoch_idx").on(t.programVersion, t.epochKey, t.marketId), // no double accrual per epoch scope
  index("liquidity_reward_state_idx").on(t.state),
]);

export const walletResearchSnapshots = pgTable("wallet_research_snapshots", {
  id: text("id").primaryKey(),
  correlationId: text("correlation_id").notNull(),
  walletAddress: text("wallet_address").notNull(),
  funderWallet: text("funder_wallet"), // linked proxy/funder wallet
  observationStartMs: bigint("observation_start_ms", { mode: "number" }).notNull(),
  observationEndMs: bigint("observation_end_ms", { mode: "number" }).notNull(),
  completeInterval: boolean("complete_interval").notNull(),
  tradesCount: integer("trades_count").notNull(),
  splitsCount: integer("splits_count").notNull(),
  mergesCount: integer("merges_count").notNull(),
  redeemsCount: integer("redeems_count").notNull(),
  transfersCount: integer("transfers_count").notNull(),
  deposits6: bigint("deposits6", { mode: "bigint" }).notNull(),
  withdrawals6: bigint("withdrawals6", { mode: "bigint" }).notNull(),
  transfersIn6: bigint("transfers_in6", { mode: "bigint" }).notNull(),
  transfersOut6: bigint("transfers_out6", { mode: "bigint" }).notNull(),
  tradingPnl6: bigint("trading_pnl6", { mode: "bigint" }),      // separated from flows; null until separable
  rebatesPaid6: bigint("rebates_paid6", { mode: "bigint" }),    // PAID incentives only
  rewardsPaid6: bigint("rewards_paid6", { mode: "bigint" }),    // PAID incentives only
  openPositionsValue6: bigint("open_positions_value6", { mode: "bigint" }),
  inventoryCostBasis6: bigint("inventory_cost_basis6", { mode: "bigint" }),
  timeWeightedCapital6: bigint("time_weighted_capital6", { mode: "bigint" }),
  attribution: jsonb("attribution"), // directional / spread / CTF / incentives / scale breakdown
  dataGaps: jsonb("data_gaps"),      // uncertainty from unavailable off-chain data
  evidenceLabel: text("evidence_label").notNull(), // EvidenceLabel
  source: text("source").notNull(),
  capturedAtMs: bigint("captured_at_ms", { mode: "number" }).notNull(),
  configVersion: integer("config_version").notNull(),
}, (t) => [
  index("wallet_research_wallet_idx").on(t.walletAddress, t.capturedAtMs),
]);

export const feedBasisEstimates = pgTable("feed_basis_estimates", {
  id: text("id").primaryKey(),
  correlationId: text("correlation_id").notNull(),
  symbol: text("symbol").notNull(),          // e.g. BTCUSD
  baseSource: text("base_source").notNull(), // e.g. binance
  refSource: text("ref_source").notNull(),   // e.g. chainlink
  windowStartMs: bigint("window_start_ms", { mode: "number" }).notNull(),
  windowEndMs: bigint("window_end_ms", { mode: "number" }).notNull(),
  sampleCount: integer("sample_count").notNull(),
  // pure statistics (ppm of ref price) — doubles by convention, never money math
  meanPpm: doublePrecision("mean_ppm").notNull(),
  medianPpm: doublePrecision("median_ppm"),
  stdPpm: doublePrecision("std_ppm").notNull(),
  madPpm: doublePrecision("mad_ppm"),
  clockOffsetMs: doublePrecision("clock_offset_ms"),
  leadLagMs: doublePrecision("lead_lag_ms"), // + = base leads ref
  regime: text("regime"),
  method: text("method").notNull(), // estimator version
  tsMs: bigint("ts_ms", { mode: "number" }).notNull(), // causal as-of time (only past data)
  configVersion: integer("config_version").notNull(),
}, (t) => [
  index("feed_basis_symbol_ts_idx").on(t.symbol, t.tsMs),
]);

export const boundaryPriceObservations = pgTable("boundary_price_observations", {
  id: text("id").primaryKey(),
  correlationId: text("correlation_id").notNull(),
  marketId: text("market_id"), // no FK: boundary capture may precede market discovery
  symbol: text("symbol").notNull(),
  boundaryKind: text("boundary_kind").notNull(), // OPEN (strike) | CLOSE (resolution)
  boundaryEpoch: bigint("boundary_epoch", { mode: "number" }).notNull(), // unix sec, 300-aligned
  valueText: text("value_text").notNull(), // exact decimal string (authoritative)
  valueFloat: doublePrecision("value_float").notNull(), // features/display only
  source: text("source").notNull(), // e.g. rtds_chainlink
  sourceTsMs: bigint("source_ts_ms", { mode: "number" }).notNull(),
  receivedTsMs: bigint("received_ts_ms", { mode: "number" }).notNull(),
  sequence: text("sequence"), // feed sequence/round metadata
  firstAtOrAfterBoundary: boolean("first_at_or_after_boundary").notNull(), // false = late capture, NOT authoritative
  officialValueText: text("official_value_text"),
  matchesOfficial: boolean("matches_official"),
  configVersion: integer("config_version").notNull(),
}, (t) => [
  uniqueIndex("boundary_obs_capture_idx").on(t.source, t.symbol, t.boundaryEpoch, t.boundaryKind), // idempotent boundary capture per source
  index("boundary_obs_market_idx").on(t.marketId),
]);

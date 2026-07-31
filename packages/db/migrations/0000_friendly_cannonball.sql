CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"correlation_id" text,
	"data" jsonb,
	"created_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backtest_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"params" jsonb NOT NULL,
	"status" text NOT NULL,
	"result" jsonb,
	"created_at_ms" bigint NOT NULL,
	"finished_at_ms" bigint
);
--> statement-breakpoint
CREATE TABLE "bankroll_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"bankroll6" bigint NOT NULL,
	"basis" text NOT NULL,
	"ts_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_versions" (
	"version" serial PRIMARY KEY NOT NULL,
	"config" jsonb NOT NULL,
	"changed_paths" jsonb,
	"actor" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "constraint_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL,
	"tick_size6" bigint NOT NULL,
	"min_order_shares6" bigint NOT NULL,
	"best_bid6" bigint,
	"best_ask6" bigint,
	"volume_usd" double precision,
	"captured_at_ms" bigint NOT NULL,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "decision_snapshots" (
	"decision_id" text PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL,
	"mode" text NOT NULL,
	"correlation_id" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engine_kv" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL,
	"ts_ms" bigint NOT NULL,
	"features" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_schedule_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL,
	"rate_ppm" bigint NOT NULL,
	"taker_only" boolean NOT NULL,
	"rebate_rate_ppm" bigint NOT NULL,
	"fee_type" text,
	"collection" text NOT NULL,
	"captured_at_ms" bigint NOT NULL,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "health_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb,
	"created_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kill_switch_events" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"reason" text NOT NULL,
	"actor" text NOT NULL,
	"created_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_rule_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL,
	"rules_text" text NOT NULL,
	"rules_hash" text NOT NULL,
	"resolution_source" text NOT NULL,
	"captured_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_trade_ticks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL,
	"token_id" text NOT NULL,
	"price6" bigint NOT NULL,
	"size6" bigint NOT NULL,
	"side" text,
	"source_ts_ms" bigint NOT NULL,
	"received_ts_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"condition_id" text NOT NULL,
	"slug" text NOT NULL,
	"question" text NOT NULL,
	"up_token_id" text NOT NULL,
	"down_token_id" text NOT NULL,
	"start_epoch" bigint NOT NULL,
	"end_epoch" bigint NOT NULL,
	"rules_text" text NOT NULL,
	"rules_hash" text NOT NULL,
	"resolution_source" text NOT NULL,
	"rules_name_chainlink" boolean NOT NULL,
	"tick_size6" bigint NOT NULL,
	"min_order_shares6" bigint NOT NULL,
	"neg_risk" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"outcome" text,
	"raw" jsonb,
	"discovered_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_fills" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"price6" bigint NOT NULL,
	"shares6" bigint NOT NULL,
	"fee_usdc6" bigint NOT NULL,
	"maker" boolean NOT NULL,
	"trade_ref" text,
	"ts_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"decision_id" text NOT NULL,
	"version" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orderbook_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL,
	"token_id" text NOT NULL,
	"bids" jsonb NOT NULL,
	"asks" jsonb NOT NULL,
	"hash" text,
	"source_ts_ms" bigint NOT NULL,
	"received_ts_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"intent_id" text NOT NULL,
	"decision_id" text NOT NULL,
	"market_id" text NOT NULL,
	"token_id" text NOT NULL,
	"outcome_side" text NOT NULL,
	"order_side" text NOT NULL,
	"style" text NOT NULL,
	"time_in_force" text NOT NULL,
	"post_only" boolean NOT NULL,
	"price6" bigint NOT NULL,
	"shares6" bigint NOT NULL,
	"filled_shares6" bigint NOT NULL,
	"stake6" bigint NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"status_reason" text,
	"expire_at_ms" bigint,
	"external_id" text,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pnl_records" (
	"id" text PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"market_id" text NOT NULL,
	"position_id" text,
	"gross6" bigint NOT NULL,
	"fees6" bigint NOT NULL,
	"rebates6" bigint NOT NULL,
	"net6" bigint NOT NULL,
	"meta" jsonb,
	"created_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" text PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL,
	"decision_id" text,
	"mode" text NOT NULL,
	"outcome_side" text NOT NULL,
	"shares6" bigint NOT NULL,
	"avg_price6" bigint NOT NULL,
	"cost6" bigint NOT NULL,
	"stake6" bigint NOT NULL,
	"exit_policy" text NOT NULL,
	"status" text NOT NULL,
	"outcome" text,
	"pnl6" bigint,
	"opened_at_ms" bigint NOT NULL,
	"resolved_at_ms" bigint
);
--> statement-breakpoint
CREATE TABLE "probability_estimates" (
	"id" text PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL,
	"ts_ms" bigint NOT NULL,
	"model_version" text NOT NULL,
	"probability6" bigint NOT NULL,
	"lower_bound6" bigint NOT NULL,
	"upper_bound6" bigint NOT NULL,
	"conservative6" bigint NOT NULL,
	"calibration_bucket" text NOT NULL,
	"uncertainty" double precision NOT NULL,
	"data_quality_penalty" double precision NOT NULL,
	"attributions" jsonb NOT NULL,
	"approved_for_live" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reference_price_ticks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"symbol" text NOT NULL,
	"value_text" text NOT NULL,
	"value_float" double precision NOT NULL,
	"source_ts_ms" bigint NOT NULL,
	"received_ts_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_markets" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"start_epoch" bigint NOT NULL,
	"end_epoch" bigint NOT NULL,
	"outcome" text NOT NULL,
	"volume_usd" double precision,
	"price_to_beat" double precision,
	"raw" jsonb,
	"ingested_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resolutions" (
	"id" text PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL,
	"outcome" text NOT NULL,
	"price_to_beat_text" text,
	"final_value_text" text,
	"official_outcome" text,
	"mismatch" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"resolved_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"decision_id" text NOT NULL,
	"approved" boolean NOT NULL,
	"reasons" jsonb NOT NULL,
	"cap_chain" jsonb NOT NULL,
	"created_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL,
	"ts_ms" bigint NOT NULL,
	"strategy_version" text NOT NULL,
	"side" text NOT NULL,
	"status" text NOT NULL,
	"detail" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timing_bucket_statistics" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"source" text NOT NULL,
	"window_days" integer NOT NULL,
	"bucket" text NOT NULL,
	"n" integer NOT NULL,
	"up" integer NOT NULL,
	"up_rate" double precision NOT NULL,
	"wilson_lo" double precision NOT NULL,
	"wilson_hi" double precision NOT NULL,
	"p_raw" double precision,
	"p_bonferroni" double precision,
	"p_bh" double precision,
	"median_abs_move_bps" double precision,
	"mean_abs_move_bps" double precision,
	"p90_abs_move_bps" double precision,
	"median_volume" double precision,
	"meta" jsonb,
	"computed_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trading_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"started_at_ms" bigint NOT NULL,
	"ended_at_ms" bigint,
	"starting_bankroll6" bigint NOT NULL,
	"peak_bankroll6" bigint NOT NULL,
	"realized6" bigint NOT NULL,
	"consecutive_losses" integer DEFAULT 0 NOT NULL,
	"stopped_reason" text
);
--> statement-breakpoint
ALTER TABLE "constraint_snapshots" ADD CONSTRAINT "constraint_snapshots_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_schedule_snapshots" ADD CONSTRAINT "fee_schedule_snapshots_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_rule_snapshots" ADD CONSTRAINT "market_rule_snapshots_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_fills" ADD CONSTRAINT "order_fills_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_intents" ADD CONSTRAINT "order_intents_decision_id_decision_snapshots_decision_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decision_snapshots"("decision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_intent_id_order_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."order_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD CONSTRAINT "risk_decisions_decision_id_decision_snapshots_decision_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decision_snapshots"("decision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_ts_idx" ON "audit_events" USING btree ("created_at_ms");--> statement-breakpoint
CREATE INDEX "decision_snapshots_market_idx" ON "decision_snapshots" USING btree ("market_id","created_at_ms");--> statement-breakpoint
CREATE INDEX "feature_snap_market_ts_idx" ON "feature_snapshots" USING btree ("market_id","ts_ms");--> statement-breakpoint
CREATE INDEX "health_events_ts_idx" ON "health_events" USING btree ("created_at_ms");--> statement-breakpoint
CREATE INDEX "trade_ticks_market_ts_idx" ON "market_trade_ticks" USING btree ("market_id","source_ts_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "markets_slug_idx" ON "markets" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "markets_end_epoch_idx" ON "markets" USING btree ("end_epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "order_intents_idem_idx" ON "order_intents" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "book_snap_market_ts_idx" ON "orderbook_snapshots" USING btree ("market_id","source_ts_ms");--> statement-breakpoint
CREATE INDEX "orders_market_idx" ON "orders" USING btree ("market_id");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "pnl_records_mode_idx" ON "pnl_records" USING btree ("mode","created_at_ms");--> statement-breakpoint
CREATE INDEX "positions_market_idx" ON "positions" USING btree ("market_id");--> statement-breakpoint
CREATE INDEX "positions_status_idx" ON "positions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ref_ticks_source_ts_idx" ON "reference_price_ticks" USING btree ("source","source_ts_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "research_markets_slug_idx" ON "research_markets" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "research_markets_end_idx" ON "research_markets" USING btree ("end_epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "resolutions_market_idx" ON "resolutions" USING btree ("market_id");--> statement-breakpoint
CREATE INDEX "signal_candidates_market_idx" ON "signal_candidates" USING btree ("market_id","ts_ms");--> statement-breakpoint
CREATE INDEX "timing_stats_run_idx" ON "timing_bucket_statistics" USING btree ("run_id");
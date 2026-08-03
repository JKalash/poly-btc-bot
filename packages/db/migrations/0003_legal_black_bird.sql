CREATE TABLE "execution_timeline_events" (
	"id" text PRIMARY KEY NOT NULL,
	"correlation_id" text NOT NULL,
	"intent_id" text NOT NULL,
	"attempt_id" text,
	"state" text NOT NULL,
	"ts_ms" bigint NOT NULL,
	"mono_ns" bigint,
	"book_snapshot_id" bigint,
	"mode" text NOT NULL,
	"detail" jsonb,
	"config_version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fill_counterfactuals" (
	"id" text PRIMARY KEY NOT NULL,
	"correlation_id" text NOT NULL,
	"decision_id" text NOT NULL,
	"market_id" text NOT NULL,
	"token_id" text NOT NULL,
	"price6" bigint NOT NULL,
	"size6" bigint NOT NULL,
	"would_fill" boolean NOT NULL,
	"reason" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"ts_ms" bigint NOT NULL,
	"config_version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fill_selection_cost_records" (
	"id" text PRIMARY KEY NOT NULL,
	"correlation_id" text NOT NULL,
	"market_id" text,
	"signal_conditioned_value6" bigint NOT NULL,
	"fill_conditioned_value6" bigint NOT NULL,
	"cost6" bigint NOT NULL,
	"signal_sample_count" integer NOT NULL,
	"fill_sample_count" integer NOT NULL,
	"window_start_ms" bigint NOT NULL,
	"window_end_ms" bigint NOT NULL,
	"ts_ms" bigint NOT NULL,
	"config_version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "latency_samples" (
	"id" text PRIMARY KEY NOT NULL,
	"correlation_id" text NOT NULL,
	"intent_id" text,
	"attempt_id" text,
	"stage" text NOT NULL,
	"duration_us" bigint NOT NULL,
	"mode" text NOT NULL,
	"ts_ms" bigint NOT NULL,
	"config_version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "markout_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"correlation_id" text NOT NULL,
	"attempt_id" text,
	"fill_id" text,
	"market_id" text NOT NULL,
	"token_id" text NOT NULL,
	"side" text NOT NULL,
	"horizon_ms" text NOT NULL,
	"mid_at_fill6" bigint NOT NULL,
	"mid_at_horizon6" bigint NOT NULL,
	"markout6" bigint NOT NULL,
	"ts_ms" bigint NOT NULL,
	"config_version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"intent_id" text NOT NULL,
	"correlation_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"request_hash" text NOT NULL,
	"token_id" text NOT NULL,
	"side" text NOT NULL,
	"price6" bigint NOT NULL,
	"size6" bigint NOT NULL,
	"remaining6" bigint NOT NULL,
	"time_in_force" text NOT NULL,
	"post_only" boolean NOT NULL,
	"status" text NOT NULL,
	"decision_book_snapshot_id" bigint,
	"send_book_snapshot_id" bigint,
	"ack_book_snapshot_id" bigint,
	"fill_book_snapshot_id" bigint,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"config_version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_variant_results" (
	"id" text PRIMARY KEY NOT NULL,
	"correlation_id" text NOT NULL,
	"decision_id" text NOT NULL,
	"market_id" text NOT NULL,
	"variant" text NOT NULL,
	"filled" boolean NOT NULL,
	"fill_price6" bigint NOT NULL,
	"fill_size6" bigint NOT NULL,
	"fee6" bigint NOT NULL,
	"pnl6" bigint,
	"detail" jsonb,
	"ts_ms" bigint NOT NULL,
	"config_version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queue_estimates" (
	"id" text PRIMARY KEY NOT NULL,
	"correlation_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"token_id" text NOT NULL,
	"price6" bigint NOT NULL,
	"ahead_shares6" bigint NOT NULL,
	"method" text NOT NULL,
	"ts_ms" bigint NOT NULL,
	"config_version" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "execution_timeline_events" ADD CONSTRAINT "execution_timeline_events_book_snapshot_id_orderbook_snapshots_id_fk" FOREIGN KEY ("book_snapshot_id") REFERENCES "public"."orderbook_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_attempts" ADD CONSTRAINT "order_attempts_intent_id_order_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."order_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_attempts" ADD CONSTRAINT "order_attempts_decision_book_snapshot_id_orderbook_snapshots_id_fk" FOREIGN KEY ("decision_book_snapshot_id") REFERENCES "public"."orderbook_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_attempts" ADD CONSTRAINT "order_attempts_send_book_snapshot_id_orderbook_snapshots_id_fk" FOREIGN KEY ("send_book_snapshot_id") REFERENCES "public"."orderbook_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_attempts" ADD CONSTRAINT "order_attempts_ack_book_snapshot_id_orderbook_snapshots_id_fk" FOREIGN KEY ("ack_book_snapshot_id") REFERENCES "public"."orderbook_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_attempts" ADD CONSTRAINT "order_attempts_fill_book_snapshot_id_orderbook_snapshots_id_fk" FOREIGN KEY ("fill_book_snapshot_id") REFERENCES "public"."orderbook_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_estimates" ADD CONSTRAINT "queue_estimates_attempt_id_order_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."order_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exec_timeline_correlation_idx" ON "execution_timeline_events" USING btree ("correlation_id","ts_ms");--> statement-breakpoint
CREATE INDEX "exec_timeline_intent_idx" ON "execution_timeline_events" USING btree ("intent_id","ts_ms");--> statement-breakpoint
CREATE INDEX "fill_counterfactuals_market_ts_idx" ON "fill_counterfactuals" USING btree ("market_id","ts_ms");--> statement-breakpoint
CREATE INDEX "fill_counterfactuals_correlation_idx" ON "fill_counterfactuals" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "fill_selection_cost_ts_idx" ON "fill_selection_cost_records" USING btree ("ts_ms");--> statement-breakpoint
CREATE INDEX "fill_selection_cost_market_idx" ON "fill_selection_cost_records" USING btree ("market_id","ts_ms");--> statement-breakpoint
CREATE INDEX "latency_samples_stage_ts_idx" ON "latency_samples" USING btree ("stage","ts_ms");--> statement-breakpoint
CREATE INDEX "latency_samples_correlation_idx" ON "latency_samples" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "markout_obs_market_ts_idx" ON "markout_observations" USING btree ("market_id","ts_ms");--> statement-breakpoint
CREATE INDEX "markout_obs_correlation_idx" ON "markout_observations" USING btree ("correlation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_attempts_intent_attempt_idx" ON "order_attempts" USING btree ("intent_id","attempt_number");--> statement-breakpoint
CREATE INDEX "order_attempts_correlation_idx" ON "order_attempts" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "order_attempts_status_idx" ON "order_attempts" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "paper_variant_decision_variant_idx" ON "paper_variant_results" USING btree ("decision_id","variant");--> statement-breakpoint
CREATE INDEX "paper_variant_market_ts_idx" ON "paper_variant_results" USING btree ("market_id","ts_ms");--> statement-breakpoint
CREATE INDEX "paper_variant_correlation_idx" ON "paper_variant_results" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "queue_estimates_attempt_ts_idx" ON "queue_estimates" USING btree ("attempt_id","ts_ms");--> statement-breakpoint
CREATE INDEX "queue_estimates_correlation_idx" ON "queue_estimates" USING btree ("correlation_id");
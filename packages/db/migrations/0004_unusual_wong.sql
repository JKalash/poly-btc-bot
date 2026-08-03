CREATE TABLE "boundary_price_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"correlation_id" text NOT NULL,
	"market_id" text,
	"symbol" text NOT NULL,
	"boundary_kind" text NOT NULL,
	"boundary_epoch" bigint NOT NULL,
	"value_text" text NOT NULL,
	"value_float" double precision NOT NULL,
	"source" text NOT NULL,
	"source_ts_ms" bigint NOT NULL,
	"received_ts_ms" bigint NOT NULL,
	"sequence" text,
	"first_at_or_after_boundary" boolean NOT NULL,
	"official_value_text" text,
	"matches_official" boolean,
	"config_version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ctf_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"correlation_id" text NOT NULL,
	"cycle_id" text,
	"market_id" text NOT NULL,
	"condition_id" text NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"mode" text NOT NULL,
	"requested_amount6" bigint NOT NULL,
	"confirmed_amount6" bigint,
	"collateral_delta6" bigint,
	"est_gas_usdc6" bigint,
	"actual_gas_usdc6" bigint,
	"relayed" boolean NOT NULL,
	"tx_hash" text,
	"failure_reason" text,
	"created_at_ms" bigint NOT NULL,
	"submitted_at_ms" bigint,
	"confirmed_at_ms" bigint,
	"updated_at_ms" bigint NOT NULL,
	"config_version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feed_basis_estimates" (
	"id" text PRIMARY KEY NOT NULL,
	"correlation_id" text NOT NULL,
	"symbol" text NOT NULL,
	"base_source" text NOT NULL,
	"ref_source" text NOT NULL,
	"window_start_ms" bigint NOT NULL,
	"window_end_ms" bigint NOT NULL,
	"sample_count" integer NOT NULL,
	"mean_ppm" double precision NOT NULL,
	"median_ppm" double precision,
	"std_ppm" double precision NOT NULL,
	"mad_ppm" double precision,
	"clock_offset_ms" double precision,
	"lead_lag_ms" double precision,
	"regime" text,
	"method" text NOT NULL,
	"ts_ms" bigint NOT NULL,
	"config_version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hedge_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"correlation_id" text NOT NULL,
	"cycle_id" text NOT NULL,
	"leg_id" text,
	"market_id" text NOT NULL,
	"token_id" text,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"mode" text NOT NULL,
	"target_shares6" bigint NOT NULL,
	"executed_shares6" bigint,
	"expected_cost6" bigint,
	"actual_cost6" bigint,
	"fee_usdc6" bigint,
	"attempt_id" text,
	"unhedged_duration_ms" bigint,
	"decided_at_ms" bigint NOT NULL,
	"executed_at_ms" bigint,
	"updated_at_ms" bigint NOT NULL,
	"config_version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_lots" (
	"id" text PRIMARY KEY NOT NULL,
	"correlation_id" text NOT NULL,
	"cycle_id" text,
	"market_id" text NOT NULL,
	"token_id" text NOT NULL,
	"outcome_side" text NOT NULL,
	"source" text NOT NULL,
	"source_ref" text,
	"mode" text NOT NULL,
	"acquired_shares6" bigint NOT NULL,
	"remaining_shares6" bigint NOT NULL,
	"cost_basis6" bigint NOT NULL,
	"acquired_at_ms" bigint NOT NULL,
	"consumed_at_ms" bigint,
	"config_version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"correlation_id" text NOT NULL,
	"market_id" text NOT NULL,
	"mode" text NOT NULL,
	"up_shares6" bigint NOT NULL,
	"down_shares6" bigint NOT NULL,
	"paired_shares6" bigint NOT NULL,
	"unpaired_up_shares6" bigint NOT NULL,
	"unpaired_down_shares6" bigint NOT NULL,
	"reserved_up_shares6" bigint NOT NULL,
	"reserved_down_shares6" bigint NOT NULL,
	"collateral_free6" bigint,
	"exchange_up_shares6" bigint,
	"exchange_down_shares6" bigint,
	"onchain_up_shares6" bigint,
	"onchain_down_shares6" bigint,
	"reconciled" boolean NOT NULL,
	"divergence" jsonb,
	"ts_ms" bigint NOT NULL,
	"config_version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "liquidity_reward_accruals" (
	"id" text PRIMARY KEY NOT NULL,
	"correlation_id" text NOT NULL,
	"program_version" text NOT NULL,
	"market_id" text,
	"epoch_key" text NOT NULL,
	"qualifying_uptime_ms" bigint,
	"score_detail" jsonb,
	"amount6" bigint NOT NULL,
	"state" text NOT NULL,
	"realized" boolean NOT NULL,
	"paid_amount6" bigint,
	"paid_at_ms" bigint,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"config_version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paired_legs" (
	"id" text PRIMARY KEY NOT NULL,
	"correlation_id" text NOT NULL,
	"cycle_id" text NOT NULL,
	"market_id" text NOT NULL,
	"token_id" text NOT NULL,
	"outcome_side" text NOT NULL,
	"order_side" text NOT NULL,
	"state" text NOT NULL,
	"price6" bigint NOT NULL,
	"size6" bigint NOT NULL,
	"filled_shares6" bigint NOT NULL,
	"avg_fill_price6" bigint,
	"fee_usdc6" bigint,
	"attempt_id" text,
	"quoted_at_ms" bigint,
	"first_fill_at_ms" bigint,
	"unhedged_started_at_ms" bigint,
	"hedged_at_ms" bigint,
	"closed_at_ms" bigint,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"config_version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paired_quote_cycles" (
	"id" text PRIMARY KEY NOT NULL,
	"correlation_id" text NOT NULL,
	"market_id" text NOT NULL,
	"mode" text NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"target_pair_price6" bigint NOT NULL,
	"collateral_committed6" bigint NOT NULL,
	"worst_case_loss6" bigint NOT NULL,
	"split_operation_id" text,
	"merge_operation_id" text,
	"one_leg_filled_at_ms" bigint,
	"hedge_completed_at_ms" bigint,
	"unhedged_duration_ms" bigint,
	"spread_captured6" bigint,
	"fees6" bigint,
	"realized_pnl6" bigint,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"reconciled_at_ms" bigint,
	"config_version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rebate_accruals" (
	"id" text PRIMARY KEY NOT NULL,
	"correlation_id" text NOT NULL,
	"program_version" text NOT NULL,
	"market_id" text NOT NULL,
	"cycle_id" text,
	"fill_id" text,
	"basis_shares6" bigint,
	"basis_notional6" bigint,
	"amount6" bigint NOT NULL,
	"state" text NOT NULL,
	"realized" boolean NOT NULL,
	"paid_amount6" bigint,
	"paid_at_ms" bigint,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"config_version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_research_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"correlation_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"funder_wallet" text,
	"observation_start_ms" bigint NOT NULL,
	"observation_end_ms" bigint NOT NULL,
	"complete_interval" boolean NOT NULL,
	"trades_count" integer NOT NULL,
	"splits_count" integer NOT NULL,
	"merges_count" integer NOT NULL,
	"redeems_count" integer NOT NULL,
	"transfers_count" integer NOT NULL,
	"deposits6" bigint NOT NULL,
	"withdrawals6" bigint NOT NULL,
	"transfers_in6" bigint NOT NULL,
	"transfers_out6" bigint NOT NULL,
	"trading_pnl6" bigint,
	"rebates_paid6" bigint,
	"rewards_paid6" bigint,
	"open_positions_value6" bigint,
	"inventory_cost_basis6" bigint,
	"time_weighted_capital6" bigint,
	"attribution" jsonb,
	"data_gaps" jsonb,
	"evidence_label" text NOT NULL,
	"source" text NOT NULL,
	"captured_at_ms" bigint NOT NULL,
	"config_version" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ctf_operations" ADD CONSTRAINT "ctf_operations_cycle_id_paired_quote_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."paired_quote_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hedge_actions" ADD CONSTRAINT "hedge_actions_cycle_id_paired_quote_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."paired_quote_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hedge_actions" ADD CONSTRAINT "hedge_actions_leg_id_paired_legs_id_fk" FOREIGN KEY ("leg_id") REFERENCES "public"."paired_legs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_cycle_id_paired_quote_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."paired_quote_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paired_legs" ADD CONSTRAINT "paired_legs_cycle_id_paired_quote_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."paired_quote_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebate_accruals" ADD CONSTRAINT "rebate_accruals_cycle_id_paired_quote_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."paired_quote_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "boundary_obs_capture_idx" ON "boundary_price_observations" USING btree ("source","symbol","boundary_epoch","boundary_kind");--> statement-breakpoint
CREATE INDEX "boundary_obs_market_idx" ON "boundary_price_observations" USING btree ("market_id");--> statement-breakpoint
CREATE INDEX "ctf_ops_cycle_idx" ON "ctf_operations" USING btree ("cycle_id");--> statement-breakpoint
CREATE INDEX "ctf_ops_market_idx" ON "ctf_operations" USING btree ("market_id","created_at_ms");--> statement-breakpoint
CREATE INDEX "ctf_ops_state_idx" ON "ctf_operations" USING btree ("state");--> statement-breakpoint
CREATE INDEX "feed_basis_symbol_ts_idx" ON "feed_basis_estimates" USING btree ("symbol","ts_ms");--> statement-breakpoint
CREATE INDEX "hedge_actions_cycle_idx" ON "hedge_actions" USING btree ("cycle_id");--> statement-breakpoint
CREATE INDEX "hedge_actions_leg_idx" ON "hedge_actions" USING btree ("leg_id");--> statement-breakpoint
CREATE INDEX "hedge_actions_decided_idx" ON "hedge_actions" USING btree ("decided_at_ms");--> statement-breakpoint
CREATE INDEX "inventory_lots_token_idx" ON "inventory_lots" USING btree ("token_id","acquired_at_ms");--> statement-breakpoint
CREATE INDEX "inventory_lots_market_idx" ON "inventory_lots" USING btree ("market_id");--> statement-breakpoint
CREATE INDEX "inventory_lots_cycle_idx" ON "inventory_lots" USING btree ("cycle_id");--> statement-breakpoint
CREATE INDEX "inventory_snapshots_market_ts_idx" ON "inventory_snapshots" USING btree ("market_id","ts_ms");--> statement-breakpoint
CREATE INDEX "inventory_snapshots_mode_ts_idx" ON "inventory_snapshots" USING btree ("mode","ts_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "liquidity_reward_epoch_idx" ON "liquidity_reward_accruals" USING btree ("program_version","epoch_key","market_id");--> statement-breakpoint
CREATE INDEX "liquidity_reward_state_idx" ON "liquidity_reward_accruals" USING btree ("state");--> statement-breakpoint
CREATE INDEX "paired_legs_cycle_idx" ON "paired_legs" USING btree ("cycle_id");--> statement-breakpoint
CREATE INDEX "paired_legs_state_idx" ON "paired_legs" USING btree ("state");--> statement-breakpoint
CREATE INDEX "paired_legs_market_idx" ON "paired_legs" USING btree ("market_id","created_at_ms");--> statement-breakpoint
CREATE INDEX "paired_cycles_market_idx" ON "paired_quote_cycles" USING btree ("market_id","created_at_ms");--> statement-breakpoint
CREATE INDEX "paired_cycles_state_idx" ON "paired_quote_cycles" USING btree ("state");--> statement-breakpoint
CREATE INDEX "paired_cycles_correlation_idx" ON "paired_quote_cycles" USING btree ("correlation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rebate_accruals_fill_idx" ON "rebate_accruals" USING btree ("fill_id");--> statement-breakpoint
CREATE INDEX "rebate_accruals_state_idx" ON "rebate_accruals" USING btree ("state");--> statement-breakpoint
CREATE INDEX "rebate_accruals_market_idx" ON "rebate_accruals" USING btree ("market_id","created_at_ms");--> statement-breakpoint
CREATE INDEX "rebate_accruals_cycle_idx" ON "rebate_accruals" USING btree ("cycle_id");--> statement-breakpoint
CREATE INDEX "wallet_research_wallet_idx" ON "wallet_research_snapshots" USING btree ("wallet_address","captured_at_ms");
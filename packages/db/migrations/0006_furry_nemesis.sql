CREATE TABLE "market_exposure_guards" (
	"market_id" text PRIMARY KEY NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_id" text NOT NULL,
	"owner_state" text NOT NULL,
	"state_version" integer DEFAULT 0 NOT NULL,
	"acquired_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"released_at_ms" bigint
);
--> statement-breakpoint
CREATE TABLE "orderbook_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL,
	"token_id" text,
	"event_kind" text NOT NULL,
	"connection_epoch" text NOT NULL,
	"envelope_id" text NOT NULL,
	"sequence_in_envelope" integer NOT NULL,
	"source_event_id" text,
	"source_ts_ms" bigint,
	"source_timestamp_kind" text NOT NULL,
	"received_ts_ms" bigint NOT NULL,
	"exchange_hash" text,
	"payload_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pair_action_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"action_sequence" integer NOT NULL,
	"action_kind" text NOT NULL,
	"capture_id" text,
	"decision_id" text NOT NULL,
	"risk_decision_id" text NOT NULL,
	"order_intent_id" text,
	"created_at_ms" bigint NOT NULL,
	CONSTRAINT "pair_action_intents_composite_idx" UNIQUE("id","group_id","action_sequence")
);
--> statement-breakpoint
CREATE TABLE "pair_book_captures" (
	"id" text PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL,
	"condition_id" text NOT NULL,
	"capture_kind" text NOT NULL,
	"captured_at_ms" bigint NOT NULL,
	"data_cutoff_event_id" bigint,
	"data_cutoff_envelope_id" text,
	"capture_sequence" bigint NOT NULL,
	"up_token_id" text NOT NULL,
	"up_book_version" bigint NOT NULL,
	"up_connection_epoch" text NOT NULL,
	"up_integrity" text NOT NULL,
	"up_source_ts_ms" bigint,
	"up_received_ts_ms" bigint NOT NULL,
	"up_source_event_id" text,
	"up_exchange_hash" text,
	"up_local_hash" text NOT NULL,
	"up_levels_json" jsonb NOT NULL,
	"down_token_id" text NOT NULL,
	"down_book_version" bigint NOT NULL,
	"down_connection_epoch" text NOT NULL,
	"down_integrity" text NOT NULL,
	"down_source_ts_ms" bigint,
	"down_received_ts_ms" bigint NOT NULL,
	"down_source_event_id" text,
	"down_exchange_hash" text,
	"down_local_hash" text NOT NULL,
	"down_levels_json" jsonb NOT NULL,
	"source_skew_ms" integer NOT NULL,
	"receive_skew_ms" integer NOT NULL,
	"up_fee_snapshot_id" text NOT NULL,
	"down_fee_snapshot_id" text NOT NULL,
	"up_constraint_snapshot_id" text NOT NULL,
	"down_constraint_snapshot_id" text NOT NULL,
	"canonical_payload" jsonb NOT NULL,
	"capture_hash" text NOT NULL,
	"created_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pair_effect_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"action_intent_id" text NOT NULL,
	"action_kind" text NOT NULL,
	"action_sequence" integer NOT NULL,
	"effect_ordinal" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"client_operation_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"request_payload" jsonb NOT NULL,
	"state" text NOT NULL,
	"not_before_ms" bigint NOT NULL,
	"deadline_ms" bigint NOT NULL,
	"claim_token" text,
	"claimed_at_ms" bigint,
	"claim_expires_at_ms" bigint,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"result_evidence_id" text,
	"last_error_code" text,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pair_group_events" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"event_type" text NOT NULL,
	"event_schema_version" integer NOT NULL,
	"causation_id" text NOT NULL,
	"correlation_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at_ms" bigint NOT NULL,
	"recorded_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pair_inbox_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"effect_id" text,
	"evidence_key" text NOT NULL,
	"evidence_kind" text NOT NULL,
	"payload_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"source_ts_ms" bigint,
	"received_ts_ms" bigint NOT NULL,
	"processed_at_ms" bigint,
	"processing_result" text,
	"created_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pair_inventory_consumptions" (
	"id" text PRIMARY KEY NOT NULL,
	"lot_id" text NOT NULL,
	"group_id" text NOT NULL,
	"event_id" text NOT NULL,
	"consumption_kind" text NOT NULL,
	"shares6" bigint NOT NULL,
	"allocated_principal_cost6" bigint NOT NULL,
	"allocated_buy_cash_fee6" bigint NOT NULL,
	"created_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pair_inventory_lots" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"market_id" text NOT NULL,
	"token_id" text NOT NULL,
	"outcome" text NOT NULL,
	"source_fill_id" text NOT NULL,
	"gross_shares6" bigint NOT NULL,
	"net_shares6" bigint NOT NULL,
	"principal_cost6" bigint NOT NULL,
	"cash_fee6" bigint NOT NULL,
	"share_fee6" bigint NOT NULL,
	"acquired_at_ms" bigint NOT NULL,
	"created_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pair_ledger_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"pair_account_id" text NOT NULL,
	"group_id" text,
	"journal_id" text NOT NULL,
	"event_id" text,
	"line_number" integer NOT NULL,
	"account" text NOT NULL,
	"asset_id" text NOT NULL,
	"amount6" bigint NOT NULL,
	"inventory_lot_id" text,
	"inventory_consumption_id" text,
	"order_id" text,
	"fill_id" text,
	"metadata" jsonb NOT NULL,
	"occurred_at_ms" bigint NOT NULL,
	"recorded_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pair_observer_bucket_stats" (
	"bucket_start_ms" bigint NOT NULL,
	"bucket_width_ms" integer NOT NULL,
	"strategy_version" text NOT NULL,
	"policy_hash" text NOT NULL,
	"market_id" text NOT NULL,
	"complete_envelopes" bigint DEFAULT 0 NOT NULL,
	"valid_synchronized_captures" bigint DEFAULT 0 NOT NULL,
	"evaluated_captures" bigint DEFAULT 0 NOT NULL,
	"prefilter_captures" bigint DEFAULT 0 NOT NULL,
	"gross_dislocations" bigint DEFAULT 0 NOT NULL,
	"full_depth_executable" bigint DEFAULT 0 NOT NULL,
	"fee_positive" bigint DEFAULT 0 NOT NULL,
	"stress_positive" bigint DEFAULT 0 NOT NULL,
	"sampled_negative_rows" bigint DEFAULT 0 NOT NULL,
	"rejection_counts_json" jsonb NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	CONSTRAINT "pair_observer_bucket_stats_pk" PRIMARY KEY("bucket_start_ms","bucket_width_ms","strategy_version","policy_hash","market_id")
);
--> statement-breakpoint
CREATE TABLE "pair_opportunity_episodes" (
	"id" text PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL,
	"strategy_version" text NOT NULL,
	"state" text NOT NULL,
	"first_observed_at_ms" bigint NOT NULL,
	"last_observed_at_ms" bigint NOT NULL,
	"closed_at_ms" bigint,
	"close_reason" text,
	"minimum_ask_sum6" bigint,
	"maximum_signal_net_pnl6" bigint,
	"maximum_activation_net_pnl6" bigint,
	"envelope_count" bigint DEFAULT 0 NOT NULL,
	"eligible_envelope_count" bigint DEFAULT 0 NOT NULL,
	"scheduled_group_count" integer DEFAULT 0 NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pair_opportunity_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"episode_id" text,
	"market_id" text NOT NULL,
	"condition_id" text NOT NULL,
	"strategy_version" text NOT NULL,
	"mode" text NOT NULL,
	"observation_kind" text NOT NULL,
	"trigger_kind" text NOT NULL,
	"trigger_id" text NOT NULL,
	"capture_id" text NOT NULL,
	"capture_hash" text NOT NULL,
	"up_fee_snapshot_id" text NOT NULL,
	"down_fee_snapshot_id" text NOT NULL,
	"up_constraint_snapshot_id" text NOT NULL,
	"down_constraint_snapshot_id" text NOT NULL,
	"policy_hash" text NOT NULL,
	"observer_operational_hash" text NOT NULL,
	"config_version" integer NOT NULL,
	"requested_cash_cap6" bigint NOT NULL,
	"selected_pair_shares6" bigint,
	"gross_top_of_book_edge6" bigint,
	"gross_walk_edge6" bigint,
	"net_pre_latency_pnl6" bigint,
	"net_pre_latency_edge_ppm" bigint,
	"one_tick_worse_pnl6" bigint,
	"two_ticks_worse_pnl6" bigint,
	"worst_case_residual_loss6" bigint,
	"operational_risk_haircut6" bigint,
	"depth_stress_json" jsonb,
	"primary_rejection_code" text,
	"rejection_codes" jsonb NOT NULL,
	"capture_summary_json" jsonb NOT NULL,
	"quote_json" jsonb,
	"decision_json" jsonb NOT NULL,
	"observed_at_ms" bigint NOT NULL,
	"created_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pair_order_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"observation_id" text NOT NULL,
	"episode_id" text,
	"pair_account_id" text NOT NULL,
	"signal_decision_id" text NOT NULL,
	"signal_risk_decision_id" text NOT NULL,
	"activation_decision_id" text,
	"activation_risk_decision_id" text,
	"latest_order_intent_id" text,
	"market_id" text NOT NULL,
	"condition_id" text NOT NULL,
	"strategy_version" text NOT NULL,
	"mode" text NOT NULL,
	"route" text NOT NULL,
	"dispatch_model" text NOT NULL,
	"settlement_policy" text NOT NULL,
	"recovery_policy" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"signal_capture_id" text NOT NULL,
	"activation_capture_id" text,
	"second_leg_capture_id" text,
	"state" text NOT NULL,
	"state_version" integer DEFAULT 0 NOT NULL,
	"event_sequence" integer DEFAULT 0 NOT NULL,
	"halted_at_ms" bigint,
	"halt_reason" text,
	"target_gross_shares6" bigint NOT NULL,
	"approved_cash_cap6" bigint NOT NULL,
	"approved_residual_loss6" bigint NOT NULL,
	"reserved_cash6" bigint NOT NULL,
	"cash_debits6" bigint DEFAULT 0 NOT NULL,
	"cash_credits6" bigint DEFAULT 0 NOT NULL,
	"cash_fees6" bigint DEFAULT 0 NOT NULL,
	"settlement_costs6" bigint DEFAULT 0 NOT NULL,
	"up_held_shares6" bigint DEFAULT 0 NOT NULL,
	"down_held_shares6" bigint DEFAULT 0 NOT NULL,
	"matched_shares6" bigint DEFAULT 0 NOT NULL,
	"residual_side" text,
	"residual_shares6" bigint DEFAULT 0 NOT NULL,
	"current_worst_case_loss6" bigint DEFAULT 0 NOT NULL,
	"peak_worst_case_loss6" bigint DEFAULT 0 NOT NULL,
	"signal_net_pnl6" bigint NOT NULL,
	"activation_net_pnl6" bigint,
	"realized_pair_pnl6" bigint,
	"realized_recovery_pnl6" bigint DEFAULT 0 NOT NULL,
	"unrealized_residual_mark6" bigint,
	"one_tick_worse_pnl6" bigint,
	"two_ticks_worse_pnl6" bigint,
	"stress_results_json" jsonb NOT NULL,
	"activate_at_ms" bigint NOT NULL,
	"next_action_at_ms" bigint,
	"recovery_deadline_ms" bigint,
	"recovery_attempts" integer DEFAULT 0 NOT NULL,
	"reconciliation_status" text NOT NULL,
	"last_reconciled_at_ms" bigint,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"closed_at_ms" bigint
);
--> statement-breakpoint
CREATE TABLE "pair_paper_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_model" text NOT NULL,
	"session_key" text NOT NULL,
	"source_config_version" integer NOT NULL,
	"source_bankroll_snapshot_id" bigint,
	"starting_cash6" bigint NOT NULL,
	"cash_available6" bigint NOT NULL,
	"cash_reserved6" bigint DEFAULT 0 NOT NULL,
	"cash_debits6" bigint DEFAULT 0 NOT NULL,
	"cash_credits6" bigint DEFAULT 0 NOT NULL,
	"realized_pnl6" bigint DEFAULT 0 NOT NULL,
	"peak_cash6" bigint NOT NULL,
	"session_drawdown6" bigint DEFAULT 0 NOT NULL,
	"daily_realized_pnl6" bigint DEFAULT 0 NOT NULL,
	"daily_bucket_utc" text NOT NULL,
	"active_group_count" integer DEFAULT 0 NOT NULL,
	"aggregate_worst_case_loss6" bigint DEFAULT 0 NOT NULL,
	"event_sequence" integer DEFAULT 0 NOT NULL,
	"state_version" integer DEFAULT 0 NOT NULL,
	"reconciliation_status" text NOT NULL,
	"last_reconciled_at_ms" bigint,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"closed_at_ms" bigint
);
--> statement-breakpoint
CREATE TABLE "pair_paper_venue_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"client_order_id" text NOT NULL,
	"effect_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"capture_id" text NOT NULL,
	"operation_kind" text NOT NULL,
	"state" text NOT NULL,
	"request_payload" jsonb NOT NULL,
	"result_payload" jsonb NOT NULL,
	"result_hash" text NOT NULL,
	"computed_at_ms" bigint NOT NULL,
	"created_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pair_reconciliation_diffs" (
	"id" text PRIMARY KEY NOT NULL,
	"reconciliation_id" text NOT NULL,
	"group_id" text NOT NULL,
	"severity" text NOT NULL,
	"code" text NOT NULL,
	"expected_json" jsonb,
	"actual_json" jsonb,
	"auto_repairable" boolean NOT NULL,
	"repaired_at_ms" bigint,
	"created_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pair_reconciliations" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text,
	"cause" text NOT NULL,
	"started_at_ms" bigint NOT NULL,
	"completed_at_ms" bigint,
	"status" text NOT NULL,
	"checked_event_sequence" integer,
	"projection_rebuilt" boolean DEFAULT false NOT NULL,
	"summary" jsonb NOT NULL,
	"created_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pair_research_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"scenario_id" text,
	"artifact_kind" text NOT NULL,
	"relative_path" text NOT NULL,
	"mime_type" text NOT NULL,
	"sha256" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"created_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pair_research_episode_results" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"scenario_id" text NOT NULL,
	"source_episode_id" text NOT NULL,
	"market_id" text NOT NULL,
	"result_kind" text NOT NULL,
	"activation_survived" boolean NOT NULL,
	"dispatch_outcome" text,
	"realized_pnl6" bigint,
	"worst_case_loss6" bigint,
	"detail_json" jsonb NOT NULL,
	"created_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pair_research_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"dataset_manifest_version" integer NOT NULL,
	"dataset_manifest_json" jsonb NOT NULL,
	"dataset_hash" text NOT NULL,
	"code_commit" text NOT NULL,
	"strategy_version" text NOT NULL,
	"base_config_json" jsonb NOT NULL,
	"base_policy_hash" text NOT NULL,
	"observer_operational_hash" text NOT NULL,
	"scenario_matrix_json" jsonb NOT NULL,
	"scenario_matrix_hash" text NOT NULL,
	"seed_algorithm" text NOT NULL,
	"seed_text" text NOT NULL,
	"first_event_id" bigint,
	"last_event_id" bigint,
	"from_ms" bigint NOT NULL,
	"to_ms" bigint NOT NULL,
	"market_count" integer DEFAULT 0 NOT NULL,
	"event_count" bigint DEFAULT 0 NOT NULL,
	"episode_count" integer DEFAULT 0 NOT NULL,
	"summary_json" jsonb,
	"promotion_verdict" text,
	"error_code" text,
	"error_detail" jsonb,
	"started_at_ms" bigint NOT NULL,
	"completed_at_ms" bigint,
	"created_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pair_research_scenarios" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"scenario_hash" text NOT NULL,
	"scenario_json" jsonb NOT NULL,
	"status" text NOT NULL,
	"market_count" integer DEFAULT 0 NOT NULL,
	"episode_count" integer DEFAULT 0 NOT NULL,
	"activation_candidate_count" integer DEFAULT 0 NOT NULL,
	"group_event_stream_hash" text,
	"metrics_json" jsonb,
	"error_code" text,
	"started_at_ms" bigint NOT NULL,
	"completed_at_ms" bigint
);
--> statement-breakpoint
ALTER TABLE "constraint_snapshots" ADD COLUMN "token_id" text;--> statement-breakpoint
ALTER TABLE "constraint_snapshots" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "constraint_snapshots" ADD COLUMN "source_payload_hash" text;--> statement-breakpoint
ALTER TABLE "constraint_snapshots" ADD COLUMN "canonical_hash" text;--> statement-breakpoint
ALTER TABLE "constraint_snapshots" ADD COLUMN "effective_at_ms" bigint;--> statement-breakpoint
ALTER TABLE "constraint_snapshots" ADD COLUMN "fetched_at_ms" bigint;--> statement-breakpoint
ALTER TABLE "fee_schedule_snapshots" ADD COLUMN "token_id" text;--> statement-breakpoint
ALTER TABLE "fee_schedule_snapshots" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "fee_schedule_snapshots" ADD COLUMN "source_payload_hash" text;--> statement-breakpoint
ALTER TABLE "fee_schedule_snapshots" ADD COLUMN "canonical_hash" text;--> statement-breakpoint
ALTER TABLE "fee_schedule_snapshots" ADD COLUMN "effective_at_ms" bigint;--> statement-breakpoint
ALTER TABLE "fee_schedule_snapshots" ADD COLUMN "fetched_at_ms" bigint;--> statement-breakpoint
ALTER TABLE "fee_schedule_snapshots" ADD COLUMN "convention_resolver_version" text;--> statement-breakpoint
ALTER TABLE "order_fills" ADD COLUMN "fee_convention" text;--> statement-breakpoint
ALTER TABLE "order_fills" ADD COLUMN "fee_shares6" bigint;--> statement-breakpoint
ALTER TABLE "order_fills" ADD COLUMN "net_shares6" bigint;--> statement-breakpoint
ALTER TABLE "order_fills" ADD COLUMN "source_evidence_id" text;--> statement-breakpoint
ALTER TABLE "order_fills" ADD COLUMN "received_at_ms" bigint;--> statement-breakpoint
ALTER TABLE "orderbook_snapshots" ADD COLUMN "connection_epoch" text;--> statement-breakpoint
ALTER TABLE "orderbook_snapshots" ADD COLUMN "book_version" bigint;--> statement-breakpoint
ALTER TABLE "orderbook_snapshots" ADD COLUMN "last_event_id" bigint;--> statement-breakpoint
ALTER TABLE "orderbook_snapshots" ADD COLUMN "source_timestamp_kind" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "pair_group_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "pair_leg_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "pair_action" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "client_order_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "effect_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "request_hash" text;--> statement-breakpoint
ALTER TABLE "pair_action_intents" ADD CONSTRAINT "pair_action_intents_group_id_pair_order_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."pair_order_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_action_intents" ADD CONSTRAINT "pair_action_intents_capture_id_pair_book_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."pair_book_captures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_action_intents" ADD CONSTRAINT "pair_action_intents_decision_id_decision_snapshots_decision_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decision_snapshots"("decision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_action_intents" ADD CONSTRAINT "pair_action_intents_risk_decision_id_risk_decisions_id_fk" FOREIGN KEY ("risk_decision_id") REFERENCES "public"."risk_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_action_intents" ADD CONSTRAINT "pair_action_intents_order_intent_id_order_intents_id_fk" FOREIGN KEY ("order_intent_id") REFERENCES "public"."order_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_book_captures" ADD CONSTRAINT "pair_book_captures_data_cutoff_event_id_orderbook_events_id_fk" FOREIGN KEY ("data_cutoff_event_id") REFERENCES "public"."orderbook_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_effect_outbox" ADD CONSTRAINT "pair_effect_outbox_group_id_pair_order_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."pair_order_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_effect_outbox" ADD CONSTRAINT "pair_effect_outbox_action_intent_id_pair_action_intents_id_fk" FOREIGN KEY ("action_intent_id") REFERENCES "public"."pair_action_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_effect_outbox" ADD CONSTRAINT "pair_effect_outbox_action_composite_fk" FOREIGN KEY ("action_intent_id","group_id","action_sequence") REFERENCES "public"."pair_action_intents"("id","group_id","action_sequence") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_group_events" ADD CONSTRAINT "pair_group_events_group_id_pair_order_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."pair_order_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_inbox_evidence" ADD CONSTRAINT "pair_inbox_evidence_group_id_pair_order_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."pair_order_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_inbox_evidence" ADD CONSTRAINT "pair_inbox_evidence_effect_id_pair_effect_outbox_id_fk" FOREIGN KEY ("effect_id") REFERENCES "public"."pair_effect_outbox"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_inventory_consumptions" ADD CONSTRAINT "pair_inventory_consumptions_lot_id_pair_inventory_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."pair_inventory_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_inventory_consumptions" ADD CONSTRAINT "pair_inventory_consumptions_group_id_pair_order_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."pair_order_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_inventory_consumptions" ADD CONSTRAINT "pair_inventory_consumptions_event_id_pair_group_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."pair_group_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_inventory_lots" ADD CONSTRAINT "pair_inventory_lots_group_id_pair_order_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."pair_order_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_ledger_entries" ADD CONSTRAINT "pair_ledger_entries_pair_account_id_pair_paper_accounts_id_fk" FOREIGN KEY ("pair_account_id") REFERENCES "public"."pair_paper_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_ledger_entries" ADD CONSTRAINT "pair_ledger_entries_group_id_pair_order_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."pair_order_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_ledger_entries" ADD CONSTRAINT "pair_ledger_entries_event_id_pair_group_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."pair_group_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_ledger_entries" ADD CONSTRAINT "pair_ledger_entries_inventory_lot_id_pair_inventory_lots_id_fk" FOREIGN KEY ("inventory_lot_id") REFERENCES "public"."pair_inventory_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_ledger_entries" ADD CONSTRAINT "pair_ledger_entries_inventory_consumption_id_pair_inventory_consumptions_id_fk" FOREIGN KEY ("inventory_consumption_id") REFERENCES "public"."pair_inventory_consumptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_opportunity_observations" ADD CONSTRAINT "pair_opportunity_observations_episode_id_pair_opportunity_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."pair_opportunity_episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_opportunity_observations" ADD CONSTRAINT "pair_opportunity_observations_capture_id_pair_book_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."pair_book_captures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_order_groups" ADD CONSTRAINT "pair_order_groups_observation_id_pair_opportunity_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."pair_opportunity_observations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_order_groups" ADD CONSTRAINT "pair_order_groups_episode_id_pair_opportunity_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."pair_opportunity_episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_order_groups" ADD CONSTRAINT "pair_order_groups_pair_account_id_pair_paper_accounts_id_fk" FOREIGN KEY ("pair_account_id") REFERENCES "public"."pair_paper_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_order_groups" ADD CONSTRAINT "pair_order_groups_signal_decision_id_decision_snapshots_decision_id_fk" FOREIGN KEY ("signal_decision_id") REFERENCES "public"."decision_snapshots"("decision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_order_groups" ADD CONSTRAINT "pair_order_groups_signal_risk_decision_id_risk_decisions_id_fk" FOREIGN KEY ("signal_risk_decision_id") REFERENCES "public"."risk_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_order_groups" ADD CONSTRAINT "pair_order_groups_activation_decision_id_decision_snapshots_decision_id_fk" FOREIGN KEY ("activation_decision_id") REFERENCES "public"."decision_snapshots"("decision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_order_groups" ADD CONSTRAINT "pair_order_groups_activation_risk_decision_id_risk_decisions_id_fk" FOREIGN KEY ("activation_risk_decision_id") REFERENCES "public"."risk_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_order_groups" ADD CONSTRAINT "pair_order_groups_latest_order_intent_id_order_intents_id_fk" FOREIGN KEY ("latest_order_intent_id") REFERENCES "public"."order_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_order_groups" ADD CONSTRAINT "pair_order_groups_signal_capture_id_pair_book_captures_id_fk" FOREIGN KEY ("signal_capture_id") REFERENCES "public"."pair_book_captures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_order_groups" ADD CONSTRAINT "pair_order_groups_activation_capture_id_pair_book_captures_id_fk" FOREIGN KEY ("activation_capture_id") REFERENCES "public"."pair_book_captures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_order_groups" ADD CONSTRAINT "pair_order_groups_second_leg_capture_id_pair_book_captures_id_fk" FOREIGN KEY ("second_leg_capture_id") REFERENCES "public"."pair_book_captures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_paper_venue_operations" ADD CONSTRAINT "pair_paper_venue_operations_effect_id_pair_effect_outbox_id_fk" FOREIGN KEY ("effect_id") REFERENCES "public"."pair_effect_outbox"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_paper_venue_operations" ADD CONSTRAINT "pair_paper_venue_operations_capture_id_pair_book_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."pair_book_captures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_reconciliation_diffs" ADD CONSTRAINT "pair_reconciliation_diffs_reconciliation_id_pair_reconciliations_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."pair_reconciliations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_reconciliation_diffs" ADD CONSTRAINT "pair_reconciliation_diffs_group_id_pair_order_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."pair_order_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_reconciliations" ADD CONSTRAINT "pair_reconciliations_group_id_pair_order_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."pair_order_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_research_artifacts" ADD CONSTRAINT "pair_research_artifacts_run_id_pair_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pair_research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_research_artifacts" ADD CONSTRAINT "pair_research_artifacts_scenario_id_pair_research_scenarios_id_fk" FOREIGN KEY ("scenario_id") REFERENCES "public"."pair_research_scenarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_research_episode_results" ADD CONSTRAINT "pair_research_episode_results_run_id_pair_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pair_research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_research_episode_results" ADD CONSTRAINT "pair_research_episode_results_scenario_id_pair_research_scenarios_id_fk" FOREIGN KEY ("scenario_id") REFERENCES "public"."pair_research_scenarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_research_scenarios" ADD CONSTRAINT "pair_research_scenarios_run_id_pair_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pair_research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "market_guards_owner_active_idx" ON "market_exposure_guards" USING btree ("owner_kind","owner_id") WHERE "market_exposure_guards"."released_at_ms" is null;--> statement-breakpoint
CREATE INDEX "market_guards_owner_state_idx" ON "market_exposure_guards" USING btree ("owner_state","updated_at_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "orderbook_events_envelope_idx" ON "orderbook_events" USING btree ("connection_epoch","envelope_id","sequence_in_envelope");--> statement-breakpoint
CREATE INDEX "orderbook_events_market_ts_idx" ON "orderbook_events" USING btree ("market_id","received_ts_ms","id");--> statement-breakpoint
CREATE INDEX "orderbook_events_token_ts_idx" ON "orderbook_events" USING btree ("token_id","received_ts_ms","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pair_action_intents_seq_idx" ON "pair_action_intents" USING btree ("group_id","action_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "pair_action_intents_order_intent_idx" ON "pair_action_intents" USING btree ("order_intent_id") WHERE "pair_action_intents"."order_intent_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "pair_captures_hash_idx" ON "pair_book_captures" USING btree ("capture_hash");--> statement-breakpoint
CREATE INDEX "pair_captures_market_ts_idx" ON "pair_book_captures" USING btree ("market_id","captured_at_ms","id");--> statement-breakpoint
CREATE INDEX "pair_captures_kind_ts_idx" ON "pair_book_captures" USING btree ("capture_kind","captured_at_ms");--> statement-breakpoint
CREATE INDEX "pair_captures_cutoff_event_idx" ON "pair_book_captures" USING btree ("data_cutoff_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pair_effect_outbox_idem_idx" ON "pair_effect_outbox" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "pair_effect_outbox_client_op_idx" ON "pair_effect_outbox" USING btree ("client_operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pair_effect_outbox_intent_ordinal_idx" ON "pair_effect_outbox" USING btree ("action_intent_id","effect_ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "pair_effect_outbox_group_action_ordinal_idx" ON "pair_effect_outbox" USING btree ("group_id","action_sequence","effect_ordinal");--> statement-breakpoint
CREATE INDEX "pair_effect_outbox_state_idx" ON "pair_effect_outbox" USING btree ("state","not_before_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "pair_group_events_seq_idx" ON "pair_group_events" USING btree ("group_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "pair_group_events_causation_idx" ON "pair_group_events" USING btree ("group_id","causation_id");--> statement-breakpoint
CREATE INDEX "pair_group_events_type_ts_idx" ON "pair_group_events" USING btree ("event_type","occurred_at_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "pair_inbox_evidence_key_idx" ON "pair_inbox_evidence" USING btree ("evidence_key");--> statement-breakpoint
CREATE UNIQUE INDEX "pair_inv_cons_event_lot_kind_idx" ON "pair_inventory_consumptions" USING btree ("event_id","lot_id","consumption_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "pair_inv_lots_source_fill_idx" ON "pair_inventory_lots" USING btree ("source_fill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pair_ledger_journal_line_idx" ON "pair_ledger_entries" USING btree ("journal_id","line_number");--> statement-breakpoint
CREATE INDEX "pair_ledger_group_ts_idx" ON "pair_ledger_entries" USING btree ("group_id","occurred_at_ms");--> statement-breakpoint
CREATE INDEX "pair_ledger_account_ts_idx" ON "pair_ledger_entries" USING btree ("pair_account_id","occurred_at_ms");--> statement-breakpoint
CREATE INDEX "pair_ledger_asset_group_idx" ON "pair_ledger_entries" USING btree ("asset_id","group_id");--> statement-breakpoint
CREATE INDEX "pair_ledger_fill_idx" ON "pair_ledger_entries" USING btree ("fill_id") WHERE "pair_ledger_entries"."fill_id" is not null;--> statement-breakpoint
CREATE INDEX "pair_episodes_market_first_idx" ON "pair_opportunity_episodes" USING btree ("market_id","first_observed_at_ms");--> statement-breakpoint
CREATE INDEX "pair_episodes_state_last_idx" ON "pair_opportunity_episodes" USING btree ("state","last_observed_at_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "pair_episodes_open_market_idx" ON "pair_opportunity_episodes" USING btree ("market_id","strategy_version") WHERE "pair_opportunity_episodes"."closed_at_ms" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "pair_obs_idem_idx" ON "pair_opportunity_observations" USING btree ("strategy_version","policy_hash","mode","trigger_kind","trigger_id","capture_hash");--> statement-breakpoint
CREATE INDEX "pair_obs_market_ts_idx" ON "pair_opportunity_observations" USING btree ("market_id","observed_at_ms");--> statement-breakpoint
CREATE INDEX "pair_obs_episode_ts_idx" ON "pair_opportunity_observations" USING btree ("episode_id","observed_at_ms");--> statement-breakpoint
CREATE INDEX "pair_obs_rejection_ts_idx" ON "pair_opportunity_observations" USING btree ("primary_rejection_code","observed_at_ms");--> statement-breakpoint
CREATE INDEX "pair_obs_pnl_ts_idx" ON "pair_opportunity_observations" USING btree ("net_pre_latency_pnl6","observed_at_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "pair_groups_idem_idx" ON "pair_order_groups" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "pair_groups_state_action_idx" ON "pair_order_groups" USING btree ("state","next_action_at_ms");--> statement-breakpoint
CREATE INDEX "pair_groups_market_created_idx" ON "pair_order_groups" USING btree ("market_id","created_at_ms");--> statement-breakpoint
CREATE INDEX "pair_groups_observation_idx" ON "pair_order_groups" USING btree ("observation_id");--> statement-breakpoint
CREATE INDEX "pair_groups_signal_decision_idx" ON "pair_order_groups" USING btree ("signal_decision_id");--> statement-breakpoint
CREATE INDEX "pair_groups_latest_intent_idx" ON "pair_order_groups" USING btree ("latest_order_intent_id");--> statement-breakpoint
CREATE INDEX "pair_groups_recon_updated_idx" ON "pair_order_groups" USING btree ("reconciliation_status","updated_at_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "pair_groups_active_market_idx" ON "pair_order_groups" USING btree ("market_id") WHERE "pair_order_groups"."state" in ('SCHEDULED', 'ACTIVATING', 'ACTIVATION_REJECTED', 'SUBMITTING', 'OUTCOME_UNKNOWN', 'NO_INITIAL_FILL', 'PAIRED', 'RESIDUAL', 'RECOVERY_PENDING', 'RECOVERING', 'RECOVERY_OUTCOME_UNKNOWN', 'AWAITING_SETTLEMENT', 'MERGE_PENDING', 'MERGE_OUTCOME_UNKNOWN', 'AWAITING_RESOLUTION', 'RECONCILING', 'MANUAL_REVIEW');--> statement-breakpoint
CREATE UNIQUE INDEX "pair_paper_accounts_session_idx" ON "pair_paper_accounts" USING btree ("session_key");--> statement-breakpoint
CREATE UNIQUE INDEX "pair_paper_ops_client_order_idx" ON "pair_paper_venue_operations" USING btree ("client_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pair_paper_ops_idem_idx" ON "pair_paper_venue_operations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "pair_research_artifacts_kind_idx" ON "pair_research_artifacts" USING btree ("run_id","artifact_kind","scenario_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pair_research_artifacts_run_level_idx" ON "pair_research_artifacts" USING btree ("run_id","artifact_kind") WHERE "pair_research_artifacts"."scenario_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "pair_research_episode_results_idx" ON "pair_research_episode_results" USING btree ("scenario_id","source_episode_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pair_research_scenarios_run_hash_idx" ON "pair_research_scenarios" USING btree ("run_id","scenario_hash");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_pair_group_id_pair_order_groups_id_fk" FOREIGN KEY ("pair_group_id") REFERENCES "public"."pair_order_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "constraint_snapshots_token_canonical_idx" ON "constraint_snapshots" USING btree ("token_id","canonical_hash") WHERE "constraint_snapshots"."token_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "fee_snapshots_token_canonical_idx" ON "fee_schedule_snapshots" USING btree ("token_id","canonical_hash") WHERE "fee_schedule_snapshots"."token_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_client_order_id_idx" ON "orders" USING btree ("client_order_id") WHERE "orders"."client_order_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_effect_id_idx" ON "orders" USING btree ("effect_id") WHERE "orders"."effect_id" is not null;
CREATE TABLE "calibration_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"model_artifact_id" text NOT NULL,
	"method" text NOT NULL,
	"curve" jsonb,
	"platt" jsonb,
	"metrics" jsonb NOT NULL,
	"per_fold_metrics" jsonb NOT NULL,
	"code_version" text NOT NULL,
	"artifact_checksum" text NOT NULL,
	"created_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dataset_manifests" (
	"id" text PRIMARY KEY NOT NULL,
	"dataset_key" text NOT NULL,
	"title" text NOT NULL,
	"source" text NOT NULL,
	"license" text,
	"files" jsonb NOT NULL,
	"content_checksum" text NOT NULL,
	"time_range_start_ms" bigint,
	"time_range_end_ms" bigint,
	"row_count" bigint,
	"schema_description" text,
	"materialized" boolean DEFAULT false NOT NULL,
	"retrieved_at_ms" bigint,
	"created_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiment_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"experiment_key" text NOT NULL,
	"title" text NOT NULL,
	"hypothesis" text NOT NULL,
	"null_hypothesis" text NOT NULL,
	"primary_metric" text NOT NULL,
	"success_criteria" text NOT NULL,
	"source_evidence_ids" jsonb NOT NULL,
	"dataset_keys" jsonb NOT NULL,
	"fold_plan" jsonb,
	"status" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiment_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"metric" text NOT NULL,
	"scope" text NOT NULL,
	"value" double precision,
	"value_text" text,
	"n" integer,
	"ci_lo" double precision,
	"ci_hi" double precision,
	"detail" jsonb,
	"created_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiment_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"definition_id" text NOT NULL,
	"run_key" text NOT NULL,
	"params" jsonb NOT NULL,
	"dataset_manifest_ids" jsonb NOT NULL,
	"code_version" text NOT NULL,
	"config_version" integer,
	"status" text NOT NULL,
	"started_at_ms" bigint NOT NULL,
	"finished_at_ms" bigint,
	"result_summary" jsonb,
	"result_checksum" text,
	"correlation_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"model_key" text NOT NULL,
	"version" text NOT NULL,
	"kind" text NOT NULL,
	"feature_names" jsonb NOT NULL,
	"coefficients" jsonb,
	"standardization" jsonb,
	"dataset_manifest_ids" jsonb NOT NULL,
	"fold_plan" jsonb NOT NULL,
	"trained_at_ms" bigint NOT NULL,
	"code_version" text NOT NULL,
	"artifact_checksum" text NOT NULL,
	"artifact" jsonb NOT NULL,
	"created_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"source_key" text NOT NULL,
	"claim_key" text NOT NULL,
	"title" text NOT NULL,
	"claim_text" text NOT NULL,
	"claimed_value" text,
	"units" text,
	"label" text NOT NULL,
	"url" text,
	"retrieved_at_ms" bigint,
	"reproduced_value" text,
	"reproduction_run_id" text,
	"methodology_notes" text,
	"correlation_id" text NOT NULL,
	"config_version" integer,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategy_promotion_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"strategy_version" text NOT NULL,
	"model_version" text NOT NULL,
	"mode" text NOT NULL,
	"approved" boolean NOT NULL,
	"reasons" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"criteria" jsonb NOT NULL,
	"calibration_artifact_id" text,
	"decided_by" text NOT NULL,
	"decided_at_ms" bigint NOT NULL,
	"active" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calibration_artifacts" ADD CONSTRAINT "calibration_artifacts_model_artifact_id_model_artifacts_id_fk" FOREIGN KEY ("model_artifact_id") REFERENCES "public"."model_artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_observations" ADD CONSTRAINT "experiment_observations_run_id_experiment_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."experiment_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_runs" ADD CONSTRAINT "experiment_runs_definition_id_experiment_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."experiment_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calibration_artifacts_model_idx" ON "calibration_artifacts" USING btree ("model_artifact_id");--> statement-breakpoint
CREATE INDEX "dataset_manifests_key_idx" ON "dataset_manifests" USING btree ("dataset_key");--> statement-breakpoint
CREATE UNIQUE INDEX "experiment_definitions_key_idx" ON "experiment_definitions" USING btree ("experiment_key");--> statement-breakpoint
CREATE INDEX "experiment_observations_run_idx" ON "experiment_observations" USING btree ("run_id","metric");--> statement-breakpoint
CREATE INDEX "experiment_runs_definition_idx" ON "experiment_runs" USING btree ("definition_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_artifacts_version_idx" ON "model_artifacts" USING btree ("version");--> statement-breakpoint
CREATE UNIQUE INDEX "source_evidence_claim_idx" ON "source_evidence" USING btree ("source_key","claim_key");--> statement-breakpoint
CREATE INDEX "source_evidence_label_idx" ON "source_evidence" USING btree ("label");--> statement-breakpoint
CREATE INDEX "strategy_promotion_idx" ON "strategy_promotion_decisions" USING btree ("strategy_version","mode","active");
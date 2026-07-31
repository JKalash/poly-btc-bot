ALTER TABLE "markets" ADD COLUMN "price_to_beat_text" text;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "price_to_beat_source" text;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "price_to_beat_captured_at_ms" bigint;
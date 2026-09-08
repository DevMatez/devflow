ALTER TABLE "webhook_events" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "processing_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "processing_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "last_error" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbox_events_relay_idx" ON "outbox_events" USING btree ("occurred_at") WHERE "outbox_events"."relayed_at" is null;
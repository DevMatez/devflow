CREATE TABLE IF NOT EXISTS "integration_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"category" text NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"external_account" jsonb NOT NULL,
	"encrypted_credentials" text NOT NULL,
	"credentials_iv" text NOT NULL,
	"token_expires_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_connections_organization_id_category_unique" UNIQUE("organization_id","category")
);
--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "claimed_by" text;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "claim_expires_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

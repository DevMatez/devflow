CREATE TABLE IF NOT EXISTS "ai_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"repo" text NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"policy_conclusion" text,
	"summary" text,
	"findings" jsonb,
	"rules_version" text,
	"prompt_version" text NOT NULL,
	"model" text,
	"provider" text,
	"check_run_external_id" text,
	"comment_external_id" text,
	"error" text,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_reviews_organization_id_repo_pr_number_head_sha_unique" UNIQUE("organization_id","repo","pr_number","head_sha")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_reviews" ADD CONSTRAINT "ai_reviews_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_reviews" ADD CONSTRAINT "ai_reviews_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_reviews_org_item_created_idx" ON "ai_reviews" USING btree ("organization_id","work_item_id","created_at");
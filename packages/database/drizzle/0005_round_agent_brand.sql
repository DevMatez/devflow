CREATE TABLE IF NOT EXISTS "work_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"external_provider" text NOT NULL,
	"external_issue_id" text NOT NULL,
	"external_issue_key" text,
	"external_issue_url" text,
	"workflow_state" text DEFAULT 'backlog' NOT NULL,
	"blocked_from_state" text,
	"workflow_execution_status" text DEFAULT 'not_started' NOT NULL,
	"workflow_execution_error" text,
	"assignee_user_id" uuid,
	"external_assignee_id" text,
	"branch_ref" jsonb,
	"pr_ref" jsonb,
	"last_external_version" text,
	"version" integer DEFAULT 0 NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_items_organization_id_external_provider_external_issue_id_unique" UNIQUE("organization_id","external_provider","external_issue_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "work_items" ADD CONSTRAINT "work_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "work_items" ADD CONSTRAINT "work_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "work_items" ADD CONSTRAINT "work_items_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "work_items_org_project_idx" ON "work_items" USING btree ("organization_id","project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "work_items_org_state_idx" ON "work_items" USING btree ("organization_id","workflow_state");
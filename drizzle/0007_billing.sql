-- Phase 5 billing, migration-only step (docs/saas-plan.md). New tables, nullable columns and a new
-- default, so the code deployed before this one keeps working while the worker migrates. The
-- billing code ships in the next deploy.
CREATE TABLE "platform_usage" (
	"month" date PRIMARY KEY NOT NULL,
	"reserved_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"spent_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trial_claims" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"hash" text NOT NULL,
	"workspace_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_job_pauses" (
	"workspace_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"job" text NOT NULL,
	"payload" jsonb NOT NULL,
	"reason" text NOT NULL,
	"message" text NOT NULL,
	"paused_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_job_pauses_workspace_id_project_id_job_pk" PRIMARY KEY("workspace_id","project_id","job")
);
--> statement-breakpoint
CREATE TABLE "workspace_usage" (
	"workspace_id" integer NOT NULL,
	"month" date NOT NULL,
	"reserved_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"spent_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"research_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"research_reserved_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_usage_workspace_id_month_pk" PRIMARY KEY("workspace_id","month")
);
--> statement-breakpoint
ALTER TABLE "workspaces" ALTER COLUMN "plan" SET DEFAULT 'none';--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "subscription_status" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "stripe_price_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "trial_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "current_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "cancel_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "billing_error" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "trial_blocked_reason" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "limits" jsonb;--> statement-breakpoint
ALTER TABLE "workspace_job_pauses" ADD CONSTRAINT "workspace_job_pauses_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_job_pauses" ADD CONSTRAINT "workspace_job_pauses_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_usage" ADD CONSTRAINT "workspace_usage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trial_claims_kind_hash_index" ON "trial_claims" USING btree ("kind","hash");--> statement-breakpoint
CREATE INDEX "trial_claims_workspace_id_index" ON "trial_claims" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_job_pauses_workspace_project_idx" ON "workspace_job_pauses" USING btree ("workspace_id","project_id");
--> statement-breakpoint
-- The owner's workspace stays on the internal plan: no Stripe, limits set by hand, its own cap.
UPDATE "workspaces" SET "plan" = 'internal' WHERE "id" = 1;
--> statement-breakpoint
-- Workspaces created before billing never started a subscription, so they have no plan yet.
UPDATE "workspaces" SET "plan" = 'none' WHERE "plan" = 'trial' AND "stripe_subscription_id" IS NULL;
--> statement-breakpoint
-- Platform backstop: every workspace's paid calls stop once DataForSEO's bill for the month reaches
-- this. The owner changes it on /settings. The code before this deploy already reads it.
INSERT INTO "settings" ("key", "value") VALUES ('platform.monthly_cap_usd', '100'::jsonb) ON CONFLICT ("key") DO NOTHING;

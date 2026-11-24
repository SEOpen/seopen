-- Phase 3 tenancy, step 1 of 2 (docs/saas-plan.md). Adds workspaces, puts workspace_id on every
-- tenant table with DEFAULT 1 (the owner's workspace) so existing rows and the previous deploy's
-- inserts land there, and adds (workspace_id, project_id) foreign keys. 0006 drops the defaults
-- and must ship in a later deploy, once this deploy's code (which always writes workspace_id) is live.
CREATE TABLE "workspace_members" (
	"workspace_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_settings" (
	"workspace_id" integer PRIMARY KEY NOT NULL,
	"monthly_cap_usd" numeric(12, 2),
	"time_zone" text DEFAULT 'America/New_York' NOT NULL,
	"default_location_code" integer DEFAULT 2840 NOT NULL,
	"default_language_code" text DEFAULT 'en' NOT NULL,
	"email_notifications" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"plan" text DEFAULT 'trial' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"stripe_customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_cache_access" (
	"key" text NOT NULL,
	"workspace_id" integer NOT NULL,
	"paid_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_cache_access_key_workspace_id_pk" PRIMARY KEY("key","workspace_id")
);
--> statement-breakpoint
-- The owner's workspace holds every row that existed before tenancy. Its id is fixed at 1:
-- the column defaults below and src/lib/workspace/current.ts rely on it.
INSERT INTO "workspaces" ("id", "name", "plan") VALUES (1, 'hello@getseopen.com', 'internal');
--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('workspaces', 'id'), (SELECT max("id") FROM "workspaces"));
--> statement-breakpoint
-- The owner's account (created by Phase 2's owner:create, if it exists yet) joins it; owner:create adds
-- the membership itself when the account is created later.
INSERT INTO "workspace_members" ("workspace_id", "user_id", "role")
SELECT 1, "id", 'owner' FROM "users" WHERE "email" = 'hello@getseopen.com';
--> statement-breakpoint
-- The single spend cap becomes the owner workspace's cap; the settings row goes in 0006.
INSERT INTO "workspace_settings" ("workspace_id", "monthly_cap_usd")
SELECT 1, (SELECT ("value" #>> '{}')::numeric FROM "settings" WHERE "key" = 'dataforseo.monthly_cap_usd');
--> statement-breakpoint
ALTER TABLE "google_accounts" DROP CONSTRAINT "google_accounts_googleSub_unique";
--> statement-breakpoint
ALTER TABLE "competitors" DROP CONSTRAINT "competitors_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "domains_snapshots" DROP CONSTRAINT "domains_snapshots_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "keywords_list_items" DROP CONSTRAINT "keywords_list_items_list_id_keywords_lists_id_fk";
--> statement-breakpoint
ALTER TABLE "keywords_lists" DROP CONSTRAINT "keywords_lists_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "rank_keywords" DROP CONSTRAINT "rank_keywords_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "rank_results" DROP CONSTRAINT "rank_results_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "rank_runs" DROP CONSTRAINT "rank_runs_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "rank_settings" DROP CONSTRAINT "rank_settings_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "rank_tasks" DROP CONSTRAINT "rank_tasks_run_id_rank_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_crawls" DROP CONSTRAINT "audit_crawls_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_duplicates" DROP CONSTRAINT "audit_duplicates_crawl_id_audit_crawls_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_issues" DROP CONSTRAINT "audit_issues_crawl_id_audit_crawls_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_lighthouse" DROP CONSTRAINT "audit_lighthouse_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_links" DROP CONSTRAINT "audit_links_crawl_id_audit_crawls_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_non_indexable" DROP CONSTRAINT "audit_non_indexable_crawl_id_audit_crawls_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_pages" DROP CONSTRAINT "audit_pages_crawl_id_audit_crawls_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_resources" DROP CONSTRAINT "audit_resources_crawl_id_audit_crawls_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_settings" DROP CONSTRAINT "audit_settings_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "backlinks_domain_decisions" DROP CONSTRAINT "backlinks_domain_decisions_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "backlinks_snapshots" DROP CONSTRAINT "backlinks_snapshots_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "ga4_landing_daily" DROP CONSTRAINT "ga4_landing_daily_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "google_sync_state" DROP CONSTRAINT "google_sync_state_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "gsc_breakdown" DROP CONSTRAINT "gsc_breakdown_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "gsc_daily" DROP CONSTRAINT "gsc_daily_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "gsc_pages" DROP CONSTRAINT "gsc_pages_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "gsc_queries" DROP CONSTRAINT "gsc_queries_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "gsc_query_pages" DROP CONSTRAINT "gsc_query_pages_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "gsc_url_inspections" DROP CONSTRAINT "gsc_url_inspections_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "ai_brand_aliases" DROP CONSTRAINT "ai_brand_aliases_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "ai_llm_mentions" DROP CONSTRAINT "ai_llm_mentions_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "ai_overviews" DROP CONSTRAINT "ai_overviews_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "ai_prompts" DROP CONSTRAINT "ai_prompts_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "ai_results" DROP CONSTRAINT "ai_results_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "ai_runs" DROP CONSTRAINT "ai_runs_project_id_projects_id_fk";
--> statement-breakpoint
DROP INDEX "audit_links_crawl_id_index";
--> statement-breakpoint
DROP INDEX "audit_non_indexable_crawl_id_index";
--> statement-breakpoint
DROP INDEX "audit_resources_crawl_id_index";
--> statement-breakpoint
ALTER TABLE "api_ledger" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "api_ledger" ADD COLUMN "charged_usd" numeric(12, 6) DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "competitors" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "domains_snapshots" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "keywords_list_items" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "keywords_lists" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "rank_keywords" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "rank_results" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "rank_runs" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "rank_settings" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "rank_tasks" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_crawls" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_duplicates" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_issues" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_lighthouse" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_links" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_non_indexable" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_pages" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_resources" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_settings" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "backlinks_domain_decisions" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "backlinks_snapshots" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "ga4_landing_daily" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "google_accounts" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "google_sync_state" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "gsc_breakdown" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "gsc_daily" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "gsc_pages" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "gsc_queries" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "gsc_query_pages" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "gsc_url_inspections" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "ai_brand_aliases" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "ai_llm_mentions" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "ai_overviews" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "ai_prompts" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "ai_results" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
-- Spend before tenancy was all the owner's own: charged what DataForSEO billed.
UPDATE "api_ledger" SET "charged_usd" = "cost_usd";
--> statement-breakpoint
-- The owner paid for every response already in the shared cache.
INSERT INTO "api_cache_access" ("key", "workspace_id") SELECT "key", 1 FROM "api_cache";
--> statement-breakpoint
-- Targets of the composite foreign keys; they must exist before the keys.
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_id_key" UNIQUE("workspace_id","id");
--> statement-breakpoint
ALTER TABLE "keywords_lists" ADD CONSTRAINT "keywords_lists_workspace_id_id_key" UNIQUE("workspace_id","id");
--> statement-breakpoint
ALTER TABLE "rank_runs" ADD CONSTRAINT "rank_runs_workspace_id_id_key" UNIQUE("workspace_id","id");
--> statement-breakpoint
ALTER TABLE "audit_crawls" ADD CONSTRAINT "audit_crawls_workspace_id_id_key" UNIQUE("workspace_id","id");
--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "api_cache_access" ADD CONSTRAINT "api_cache_access_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "api_ledger" ADD CONSTRAINT "api_ledger_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domains_snapshots" ADD CONSTRAINT "domains_snapshots_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "keywords_list_items" ADD CONSTRAINT "keywords_list_items_parent_fk" FOREIGN KEY ("workspace_id","list_id") REFERENCES "public"."keywords_lists"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "keywords_lists" ADD CONSTRAINT "keywords_lists_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rank_keywords" ADD CONSTRAINT "rank_keywords_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rank_results" ADD CONSTRAINT "rank_results_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rank_runs" ADD CONSTRAINT "rank_runs_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rank_settings" ADD CONSTRAINT "rank_settings_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rank_tasks" ADD CONSTRAINT "rank_tasks_parent_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."rank_runs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "audit_crawls" ADD CONSTRAINT "audit_crawls_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "audit_duplicates" ADD CONSTRAINT "audit_duplicates_parent_fk" FOREIGN KEY ("workspace_id","crawl_id") REFERENCES "public"."audit_crawls"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "audit_issues" ADD CONSTRAINT "audit_issues_parent_fk" FOREIGN KEY ("workspace_id","crawl_id") REFERENCES "public"."audit_crawls"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "audit_lighthouse" ADD CONSTRAINT "audit_lighthouse_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "audit_links" ADD CONSTRAINT "audit_links_parent_fk" FOREIGN KEY ("workspace_id","crawl_id") REFERENCES "public"."audit_crawls"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "audit_non_indexable" ADD CONSTRAINT "audit_non_indexable_parent_fk" FOREIGN KEY ("workspace_id","crawl_id") REFERENCES "public"."audit_crawls"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "audit_pages" ADD CONSTRAINT "audit_pages_parent_fk" FOREIGN KEY ("workspace_id","crawl_id") REFERENCES "public"."audit_crawls"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "audit_resources" ADD CONSTRAINT "audit_resources_parent_fk" FOREIGN KEY ("workspace_id","crawl_id") REFERENCES "public"."audit_crawls"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "audit_settings" ADD CONSTRAINT "audit_settings_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "backlinks_domain_decisions" ADD CONSTRAINT "backlinks_domain_decisions_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "backlinks_snapshots" ADD CONSTRAINT "backlinks_snapshots_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ga4_landing_daily" ADD CONSTRAINT "ga4_landing_daily_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "google_accounts" ADD CONSTRAINT "google_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "google_sync_state" ADD CONSTRAINT "google_sync_state_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gsc_breakdown" ADD CONSTRAINT "gsc_breakdown_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gsc_daily" ADD CONSTRAINT "gsc_daily_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gsc_pages" ADD CONSTRAINT "gsc_pages_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gsc_queries" ADD CONSTRAINT "gsc_queries_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gsc_query_pages" ADD CONSTRAINT "gsc_query_pages_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gsc_url_inspections" ADD CONSTRAINT "gsc_url_inspections_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_brand_aliases" ADD CONSTRAINT "ai_brand_aliases_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_llm_mentions" ADD CONSTRAINT "ai_llm_mentions_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_overviews" ADD CONSTRAINT "ai_overviews_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_prompts" ADD CONSTRAINT "ai_prompts_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_results" ADD CONSTRAINT "ai_results_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "workspace_members_user_id_index" ON "workspace_members" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "api_cache_access_workspace_id_index" ON "api_cache_access" USING btree ("workspace_id");
--> statement-breakpoint
CREATE INDEX "api_ledger_workspace_id_created_at_index" ON "api_ledger" USING btree ("workspace_id","created_at");
--> statement-breakpoint
CREATE INDEX "competitors_workspace_project_idx" ON "competitors" USING btree ("workspace_id","project_id");
--> statement-breakpoint
CREATE INDEX "domains_snapshots_workspace_project_idx" ON "domains_snapshots" USING btree ("workspace_id","project_id");
--> statement-breakpoint
CREATE INDEX "keywords_list_items_workspace_parent_idx" ON "keywords_list_items" USING btree ("workspace_id","list_id");
--> statement-breakpoint
CREATE INDEX "keywords_lists_workspace_project_idx" ON "keywords_lists" USING btree ("workspace_id","project_id");
--> statement-breakpoint
CREATE INDEX "rank_keywords_workspace_project_idx" ON "rank_keywords" USING btree ("workspace_id","project_id");
--> statement-breakpoint
CREATE INDEX "rank_results_workspace_project_idx" ON "rank_results" USING btree ("workspace_id","project_id");
--> statement-breakpoint
CREATE INDEX "rank_runs_workspace_project_idx" ON "rank_runs" USING btree ("workspace_id","project_id");
--> statement-breakpoint
CREATE INDEX "rank_settings_workspace_project_idx" ON "rank_settings" USING btree ("workspace_id","project_id");
--> statement-breakpoint
CREATE INDEX "rank_tasks_workspace_parent_idx" ON "rank_tasks" USING btree ("workspace_id","run_id");
--> statement-breakpoint
CREATE INDEX "audit_crawls_workspace_project_idx" ON "audit_crawls" USING btree ("workspace_id","project_id");
--> statement-breakpoint
CREATE INDEX "audit_duplicates_workspace_parent_idx" ON "audit_duplicates" USING btree ("workspace_id","crawl_id");
--> statement-breakpoint
CREATE INDEX "audit_issues_workspace_parent_idx" ON "audit_issues" USING btree ("workspace_id","crawl_id");
--> statement-breakpoint
CREATE INDEX "audit_lighthouse_workspace_project_idx" ON "audit_lighthouse" USING btree ("workspace_id","project_id");
--> statement-breakpoint
CREATE INDEX "audit_links_workspace_parent_idx" ON "audit_links" USING btree ("workspace_id","crawl_id");
--> statement-breakpoint
CREATE INDEX "audit_non_indexable_workspace_parent_idx" ON "audit_non_indexable" USING btree ("workspace_id","crawl_id");
--> statement-breakpoint
CREATE INDEX "audit_pages_workspace_parent_idx" ON "audit_pages" USING btree ("workspace_id","crawl_id");
--> statement-breakpoint
CREATE INDEX "audit_resources_workspace_parent_idx" ON "audit_resources" USING btree ("workspace_id","crawl_id");
--> statement-breakpoint
CREATE INDEX "audit_settings_workspace_project_idx" ON "audit_settings" USING btree ("workspace_id","project_id");
--> statement-breakpoint
CREATE INDEX "backlinks_domain_decisions_workspace_project_idx" ON "backlinks_domain_decisions" USING btree ("workspace_id","project_id");
--> statement-breakpoint
CREATE INDEX "backlinks_snapshots_workspace_project_idx" ON "backlinks_snapshots" USING btree ("workspace_id","project_id");
--> statement-breakpoint
CREATE INDEX "ga4_landing_daily_workspace_project_idx" ON "ga4_landing_daily" USING btree ("workspace_id","project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "google_accounts_workspace_id_key" ON "google_accounts" USING btree ("workspace_id");
--> statement-breakpoint
CREATE INDEX "google_sync_state_workspace_project_idx" ON "google_sync_state" USING btree ("workspace_id","project_id");
--> statement-breakpoint
CREATE INDEX "gsc_breakdown_workspace_project_idx" ON "gsc_breakdown" USING btree ("workspace_id","project_id");
--> statement-breakpoint
CREATE INDEX "gsc_daily_workspace_project_idx" ON "gsc_daily" USING btree ("workspace_id","project_id");
--> statement-breakpoint
CREATE INDEX "gsc_pages_workspace_project_idx" ON "gsc_pages" USING btree ("workspace_id","project_id");
--> statement-breakpoint
CREATE INDEX "gsc_queries_workspace_project_idx" ON "gsc_queries" USING btree ("workspace_id","project_id");
--> statement-breakpoint
CREATE INDEX "gsc_query_pages_workspace_project_idx" ON "gsc_query_pages" USING btree ("workspace_id","project_id");
--> statement-breakpoint
CREATE INDEX "gsc_url_inspections_workspace_project_idx" ON "gsc_url_inspections" USING btree ("workspace_id","project_id");
--> statement-breakpoint
CREATE INDEX "ai_brand_aliases_workspace_project_idx" ON "ai_brand_aliases" USING btree ("workspace_id","project_id");
--> statement-breakpoint
CREATE INDEX "ai_llm_mentions_workspace_project_idx" ON "ai_llm_mentions" USING btree ("workspace_id","project_id");
--> statement-breakpoint
CREATE INDEX "ai_overviews_workspace_project_idx" ON "ai_overviews" USING btree ("workspace_id","project_id");
--> statement-breakpoint
CREATE INDEX "ai_prompts_workspace_project_idx" ON "ai_prompts" USING btree ("workspace_id","project_id");
--> statement-breakpoint
CREATE INDEX "ai_results_workspace_project_idx" ON "ai_results" USING btree ("workspace_id","project_id");
--> statement-breakpoint
CREATE INDEX "ai_runs_workspace_project_idx" ON "ai_runs" USING btree ("workspace_id","project_id");

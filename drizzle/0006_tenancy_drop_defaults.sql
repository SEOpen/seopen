-- Phase 3 tenancy, step 2 of 2. Ships in the deploy after 0005, once only code that always writes
-- workspace_id is running: from here an insert without a workspace fails instead of landing in the
-- owner's workspace.
--
-- Ledger rows the pre-tenancy code wrote between the two deploys have charged_usd 0 (its default);
-- that code only made the owner's own paid calls, so they are charged what DataForSEO billed. New
-- code never writes a nonzero cost with a zero charge.
UPDATE "api_ledger" SET "charged_usd" = "cost_usd" WHERE "charged_usd" = 0 AND "cost_usd" <> 0;
--> statement-breakpoint
-- The spend cap moved to workspace_settings in 0005.
DELETE FROM "settings" WHERE "key" = 'dataforseo.monthly_cap_usd';
--> statement-breakpoint
ALTER TABLE "ai_brand_aliases" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "ai_llm_mentions" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "ai_overviews" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "ai_prompts" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "ai_results" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "ai_runs" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "api_ledger" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "audit_crawls" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "audit_duplicates" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "audit_issues" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "audit_lighthouse" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "audit_links" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "audit_non_indexable" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "audit_pages" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "audit_resources" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "audit_settings" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "backlinks_domain_decisions" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "backlinks_snapshots" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "competitors" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "domains_snapshots" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "ga4_landing_daily" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "google_accounts" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "google_sync_state" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "gsc_breakdown" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "gsc_daily" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "gsc_pages" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "gsc_queries" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "gsc_query_pages" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "gsc_url_inspections" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "keywords_list_items" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "keywords_lists" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "rank_keywords" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "rank_results" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "rank_runs" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "rank_settings" ALTER COLUMN "workspace_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "rank_tasks" ALTER COLUMN "workspace_id" DROP DEFAULT;

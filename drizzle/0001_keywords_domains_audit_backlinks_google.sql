CREATE TABLE "domains_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"domain" text NOT NULL,
	"location_code" integer NOT NULL,
	"language_code" text NOT NULL,
	"date" date NOT NULL,
	"keywords" integer NOT NULL,
	"traffic" integer NOT NULL,
	"traffic_value" real NOT NULL,
	"top3" integer NOT NULL,
	"top10" integer NOT NULL,
	"distribution" jsonb NOT NULL,
	"changes" jsonb NOT NULL,
	"history" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "keywords_list_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"list_id" integer NOT NULL,
	"keyword" text NOT NULL,
	"location_code" integer NOT NULL,
	"language_code" text NOT NULL,
	"volume" integer,
	"kd" integer,
	"cpc" real,
	"competition" real,
	"intent" text,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "keywords_lists" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_crawls" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"task_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"target" text NOT NULL,
	"max_pages" integer NOT NULL,
	"enable_javascript" boolean DEFAULT false NOT NULL,
	"load_resources" boolean DEFAULT true NOT NULL,
	"estimated_cost_usd" real DEFAULT 0 NOT NULL,
	"cost_usd" real,
	"pages_crawled" integer DEFAULT 0 NOT NULL,
	"pages_in_queue" integer DEFAULT 0 NOT NULL,
	"health_score" real,
	"errors" integer,
	"warnings" integer,
	"notices" integer,
	"pages_with_issues" integer,
	"summary" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"last_polled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_duplicates" (
	"id" serial PRIMARY KEY NOT NULL,
	"crawl_id" integer NOT NULL,
	"kind" text NOT NULL,
	"value" text,
	"urls" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_issues" (
	"id" serial PRIMARY KEY NOT NULL,
	"crawl_id" integer NOT NULL,
	"code" text NOT NULL,
	"url" text NOT NULL,
	"detail" text
);
--> statement-breakpoint
CREATE TABLE "audit_lighthouse" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"url" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"for_mobile" boolean DEFAULT false NOT NULL,
	"performance" real,
	"accessibility" real,
	"best_practices" real,
	"seo" real,
	"metrics" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"crawl_id" integer NOT NULL,
	"from_url" text NOT NULL,
	"to_url" text NOT NULL,
	"direction" text,
	"link_type" text,
	"dofollow" boolean,
	"is_broken" boolean,
	"anchor" text
);
--> statement-breakpoint
CREATE TABLE "audit_non_indexable" (
	"id" serial PRIMARY KEY NOT NULL,
	"crawl_id" integer NOT NULL,
	"url" text NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "audit_pages" (
	"id" serial PRIMARY KEY NOT NULL,
	"crawl_id" integer NOT NULL,
	"url" text NOT NULL,
	"status_code" integer,
	"resource_type" text,
	"title" text,
	"description" text,
	"h1" text,
	"canonical" text,
	"depth" integer,
	"word_count" integer,
	"internal_links_out" integer,
	"external_links_out" integer,
	"internal_links_in" integer,
	"load_time_ms" integer,
	"size_bytes" integer,
	"onpage_score" real,
	"indexable" boolean,
	"checks" jsonb,
	"issue_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_resources" (
	"id" serial PRIMARY KEY NOT NULL,
	"crawl_id" integer NOT NULL,
	"url" text NOT NULL,
	"resource_type" text,
	"status_code" integer,
	"size_bytes" integer,
	"checks" jsonb
);
--> statement-breakpoint
CREATE TABLE "audit_settings" (
	"project_id" integer PRIMARY KEY NOT NULL,
	"max_pages" integer DEFAULT 500 NOT NULL,
	"enable_javascript" boolean DEFAULT false NOT NULL,
	"load_resources" boolean DEFAULT true NOT NULL,
	"weekly_enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backlinks_domain_decisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"domain" text NOT NULL,
	"decision" text NOT NULL,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backlinks_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"date" date NOT NULL,
	"target" text NOT NULL,
	"backlinks" integer NOT NULL,
	"referring_domains" integer NOT NULL,
	"referring_main_domains" integer,
	"rank" integer,
	"spam_score" integer,
	"nofollow_backlinks" integer,
	"broken_backlinks" integer,
	"dofollow_share" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ga4_landing_daily" (
	"project_id" integer NOT NULL,
	"date" date NOT NULL,
	"host_name" text NOT NULL,
	"landing_page" text NOT NULL,
	"sessions" integer NOT NULL,
	"engaged_sessions" integer NOT NULL,
	"key_events" double precision NOT NULL,
	"total_revenue" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"google_sub" text NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"scopes" text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"refresh_token_expires_at" timestamp with time zone,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_refresh_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "google_accounts_googleSub_unique" UNIQUE("google_sub")
);
--> statement-breakpoint
CREATE TABLE "google_sync_state" (
	"project_id" integer NOT NULL,
	"source" text NOT NULL,
	"property" text NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"message" text,
	"last_run_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"latest_date" date,
	"backfill_start" date,
	"backfill_cursor" date,
	"backfill_done" boolean DEFAULT false NOT NULL,
	"quota_failures" integer DEFAULT 0 NOT NULL,
	"rows_written" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "google_sync_state_project_id_source_pk" PRIMARY KEY("project_id","source")
);
--> statement-breakpoint
CREATE TABLE "gsc_breakdown" (
	"project_id" integer NOT NULL,
	"date" date NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"clicks" integer NOT NULL,
	"impressions" integer NOT NULL,
	"ctr" double precision NOT NULL,
	"position" double precision NOT NULL,
	CONSTRAINT "gsc_breakdown_project_id_kind_date_key_pk" PRIMARY KEY("project_id","kind","date","key")
);
--> statement-breakpoint
CREATE TABLE "gsc_daily" (
	"project_id" integer NOT NULL,
	"date" date NOT NULL,
	"clicks" integer NOT NULL,
	"impressions" integer NOT NULL,
	"ctr" double precision NOT NULL,
	"position" double precision NOT NULL,
	CONSTRAINT "gsc_daily_project_id_date_pk" PRIMARY KEY("project_id","date")
);
--> statement-breakpoint
CREATE TABLE "gsc_pages" (
	"project_id" integer NOT NULL,
	"date" date NOT NULL,
	"page" text NOT NULL,
	"clicks" integer NOT NULL,
	"impressions" integer NOT NULL,
	"ctr" double precision NOT NULL,
	"position" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gsc_queries" (
	"project_id" integer NOT NULL,
	"date" date NOT NULL,
	"query" text NOT NULL,
	"clicks" integer NOT NULL,
	"impressions" integer NOT NULL,
	"ctr" double precision NOT NULL,
	"position" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gsc_query_pages" (
	"project_id" integer NOT NULL,
	"date" date NOT NULL,
	"query" text NOT NULL,
	"page" text NOT NULL,
	"clicks" integer NOT NULL,
	"impressions" integer NOT NULL,
	"ctr" double precision NOT NULL,
	"position" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gsc_url_inspections" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"url" text NOT NULL,
	"inspected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verdict" text,
	"coverage_state" text,
	"indexing_state" text,
	"robots_txt_state" text,
	"page_fetch_state" text,
	"last_crawl_time" timestamp with time zone,
	"google_canonical" text,
	"user_canonical" text,
	"crawled_as" text,
	"inspection_result_link" text,
	"rich_results" jsonb
);
--> statement-breakpoint
ALTER TABLE "domains_snapshots" ADD CONSTRAINT "domains_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keywords_list_items" ADD CONSTRAINT "keywords_list_items_list_id_keywords_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."keywords_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keywords_lists" ADD CONSTRAINT "keywords_lists_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_crawls" ADD CONSTRAINT "audit_crawls_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_duplicates" ADD CONSTRAINT "audit_duplicates_crawl_id_audit_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."audit_crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_issues" ADD CONSTRAINT "audit_issues_crawl_id_audit_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."audit_crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_lighthouse" ADD CONSTRAINT "audit_lighthouse_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_links" ADD CONSTRAINT "audit_links_crawl_id_audit_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."audit_crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_non_indexable" ADD CONSTRAINT "audit_non_indexable_crawl_id_audit_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."audit_crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_pages" ADD CONSTRAINT "audit_pages_crawl_id_audit_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."audit_crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_resources" ADD CONSTRAINT "audit_resources_crawl_id_audit_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."audit_crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_settings" ADD CONSTRAINT "audit_settings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlinks_domain_decisions" ADD CONSTRAINT "backlinks_domain_decisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlinks_snapshots" ADD CONSTRAINT "backlinks_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ga4_landing_daily" ADD CONSTRAINT "ga4_landing_daily_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_sync_state" ADD CONSTRAINT "google_sync_state_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_breakdown" ADD CONSTRAINT "gsc_breakdown_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_daily" ADD CONSTRAINT "gsc_daily_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_pages" ADD CONSTRAINT "gsc_pages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_queries" ADD CONSTRAINT "gsc_queries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_query_pages" ADD CONSTRAINT "gsc_query_pages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_url_inspections" ADD CONSTRAINT "gsc_url_inspections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "domains_snapshots_project_id_date_index" ON "domains_snapshots" USING btree ("project_id","date");--> statement-breakpoint
CREATE INDEX "domains_snapshots_project_id_created_at_index" ON "domains_snapshots" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "keywords_list_items_list_id_keyword_index" ON "keywords_list_items" USING btree ("list_id","keyword");--> statement-breakpoint
CREATE INDEX "keywords_list_items_list_id_created_at_index" ON "keywords_list_items" USING btree ("list_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "keywords_lists_project_id_name_index" ON "keywords_lists" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "audit_crawls_project_id_created_at_index" ON "audit_crawls" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_crawls_status_index" ON "audit_crawls" USING btree ("status");--> statement-breakpoint
CREATE INDEX "audit_duplicates_crawl_id_kind_index" ON "audit_duplicates" USING btree ("crawl_id","kind");--> statement-breakpoint
CREATE INDEX "audit_issues_crawl_id_code_index" ON "audit_issues" USING btree ("crawl_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_issues_crawl_id_code_url_index" ON "audit_issues" USING btree ("crawl_id","code","url");--> statement-breakpoint
CREATE INDEX "audit_lighthouse_project_id_created_at_index" ON "audit_lighthouse" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_links_crawl_id_index" ON "audit_links" USING btree ("crawl_id");--> statement-breakpoint
CREATE INDEX "audit_non_indexable_crawl_id_index" ON "audit_non_indexable" USING btree ("crawl_id");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_pages_crawl_id_url_index" ON "audit_pages" USING btree ("crawl_id","url");--> statement-breakpoint
CREATE INDEX "audit_pages_crawl_id_status_code_index" ON "audit_pages" USING btree ("crawl_id","status_code");--> statement-breakpoint
CREATE INDEX "audit_resources_crawl_id_index" ON "audit_resources" USING btree ("crawl_id");--> statement-breakpoint
CREATE UNIQUE INDEX "backlinks_domain_decisions_project_id_domain_index" ON "backlinks_domain_decisions" USING btree ("project_id","domain");--> statement-breakpoint
CREATE INDEX "backlinks_domain_decisions_project_id_decision_index" ON "backlinks_domain_decisions" USING btree ("project_id","decision");--> statement-breakpoint
CREATE UNIQUE INDEX "backlinks_snapshots_project_id_date_index" ON "backlinks_snapshots" USING btree ("project_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "ga4_landing_daily_project_id_date_host_name_landing_page_index" ON "ga4_landing_daily" USING btree ("project_id","date","host_name","landing_page");--> statement-breakpoint
CREATE INDEX "ga4_landing_daily_project_id_date_index" ON "ga4_landing_daily" USING btree ("project_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "gsc_pages_project_id_date_page_index" ON "gsc_pages" USING btree ("project_id","date","page");--> statement-breakpoint
CREATE INDEX "gsc_pages_project_id_page_index" ON "gsc_pages" USING btree ("project_id","page");--> statement-breakpoint
CREATE UNIQUE INDEX "gsc_queries_project_id_date_query_index" ON "gsc_queries" USING btree ("project_id","date","query");--> statement-breakpoint
CREATE INDEX "gsc_queries_project_id_query_index" ON "gsc_queries" USING btree ("project_id","query");--> statement-breakpoint
CREATE UNIQUE INDEX "gsc_query_pages_project_id_date_query_page_index" ON "gsc_query_pages" USING btree ("project_id","date","query","page");--> statement-breakpoint
CREATE INDEX "gsc_query_pages_project_id_query_index" ON "gsc_query_pages" USING btree ("project_id","query");--> statement-breakpoint
CREATE INDEX "gsc_query_pages_project_id_page_index" ON "gsc_query_pages" USING btree ("project_id","page");--> statement-breakpoint
CREATE INDEX "gsc_url_inspections_project_id_inspected_at_index" ON "gsc_url_inspections" USING btree ("project_id","inspected_at");
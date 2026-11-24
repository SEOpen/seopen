CREATE TABLE "rank_keywords" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"keyword" text NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"device" text DEFAULT 'desktop' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"search_volume" integer,
	"cpc" real,
	"difficulty" smallint,
	"volume_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rank_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"keyword_id" integer NOT NULL,
	"date" date NOT NULL,
	"run_id" integer,
	"depth" smallint NOT NULL,
	"position" smallint,
	"rank_absolute" smallint,
	"url" text,
	"own_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"serp_features" text[] DEFAULT '{}' NOT NULL,
	"owned_features" text[] DEFAULT '{}' NOT NULL,
	"ai_overview" boolean DEFAULT false NOT NULL,
	"ai_overview_cited" boolean DEFAULT false NOT NULL,
	"domains" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"top" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"se_results_count" integer,
	"checked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rank_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"kind" text NOT NULL,
	"date" date NOT NULL,
	"depth" smallint NOT NULL,
	"ai_overview" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'posting' NOT NULL,
	"tasks_total" integer DEFAULT 0 NOT NULL,
	"tasks_done" integer DEFAULT 0 NOT NULL,
	"tasks_failed" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rank_settings" (
	"project_id" integer PRIMARY KEY NOT NULL,
	"daily_depth" smallint DEFAULT 20 NOT NULL,
	"sweep_depth" smallint DEFAULT 100 NOT NULL,
	"sweep_weekday" smallint DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rank_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"keyword_id" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fetched_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ai_brand_aliases" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"domain" text NOT NULL,
	"alias" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_llm_mentions" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"platform" text NOT NULL,
	"domain" text NOT NULL,
	"own" boolean DEFAULT false NOT NULL,
	"mentions" integer DEFAULT 0 NOT NULL,
	"ai_search_volume" numeric(16, 0) DEFAULT 0 NOT NULL,
	"top_sources" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_overviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"prompt_id" integer NOT NULL,
	"keyword" text NOT NULL,
	"task_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"present" boolean,
	"cited" boolean,
	"mentioned" boolean,
	"text" text,
	"references" jsonb,
	"cost_usd" numeric(12, 6),
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ai_prompts" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"prompt" text NOT NULL,
	"keyword" text,
	"platforms" text[] NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"prompt_id" integer NOT NULL,
	"platform" text NOT NULL,
	"task_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"model" text,
	"answer" text,
	"citations" jsonb,
	"mentions" jsonb,
	"mentioned" boolean,
	"cited" boolean,
	"position" integer,
	"cost_usd" numeric(12, 6),
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ai_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"estimated_cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"tasks_total" integer DEFAULT 0 NOT NULL,
	"tasks_done" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "rank_keywords" ADD CONSTRAINT "rank_keywords_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rank_results" ADD CONSTRAINT "rank_results_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rank_results" ADD CONSTRAINT "rank_results_keyword_id_rank_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."rank_keywords"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rank_results" ADD CONSTRAINT "rank_results_run_id_rank_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."rank_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rank_runs" ADD CONSTRAINT "rank_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rank_settings" ADD CONSTRAINT "rank_settings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rank_tasks" ADD CONSTRAINT "rank_tasks_run_id_rank_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."rank_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rank_tasks" ADD CONSTRAINT "rank_tasks_keyword_id_rank_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."rank_keywords"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_brand_aliases" ADD CONSTRAINT "ai_brand_aliases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_llm_mentions" ADD CONSTRAINT "ai_llm_mentions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_overviews" ADD CONSTRAINT "ai_overviews_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_overviews" ADD CONSTRAINT "ai_overviews_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_overviews" ADD CONSTRAINT "ai_overviews_prompt_id_ai_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."ai_prompts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_prompts" ADD CONSTRAINT "ai_prompts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_results" ADD CONSTRAINT "ai_results_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_results" ADD CONSTRAINT "ai_results_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_results" ADD CONSTRAINT "ai_results_prompt_id_ai_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."ai_prompts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rank_keywords_project_id_keyword_device_index" ON "rank_keywords" USING btree ("project_id","keyword","device");--> statement-breakpoint
CREATE INDEX "rank_keywords_project_id_active_index" ON "rank_keywords" USING btree ("project_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "rank_results_keyword_id_date_index" ON "rank_results" USING btree ("keyword_id","date");--> statement-breakpoint
CREATE INDEX "rank_results_project_id_date_index" ON "rank_results" USING btree ("project_id","date");--> statement-breakpoint
CREATE INDEX "rank_runs_project_id_created_at_index" ON "rank_runs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "rank_runs_status_index" ON "rank_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "rank_tasks_status_posted_at_index" ON "rank_tasks" USING btree ("status","posted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rank_tasks_run_id_keyword_id_index" ON "rank_tasks" USING btree ("run_id","keyword_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_brand_aliases_project_id_domain_alias_index" ON "ai_brand_aliases" USING btree ("project_id","domain","alias");--> statement-breakpoint
CREATE INDEX "ai_llm_mentions_project_id_fetched_at_index" ON "ai_llm_mentions" USING btree ("project_id","fetched_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_overviews_run_id_prompt_id_index" ON "ai_overviews" USING btree ("run_id","prompt_id");--> statement-breakpoint
CREATE INDEX "ai_overviews_project_id_created_at_index" ON "ai_overviews" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_overviews_status_index" ON "ai_overviews" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_prompts_project_id_prompt_index" ON "ai_prompts" USING btree ("project_id","prompt");--> statement-breakpoint
CREATE INDEX "ai_prompts_project_id_active_index" ON "ai_prompts" USING btree ("project_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_results_run_id_prompt_id_platform_index" ON "ai_results" USING btree ("run_id","prompt_id","platform");--> statement-breakpoint
CREATE INDEX "ai_results_project_id_created_at_index" ON "ai_results" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_results_prompt_id_platform_index" ON "ai_results" USING btree ("prompt_id","platform");--> statement-breakpoint
CREATE INDEX "ai_results_status_index" ON "ai_results" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ai_runs_project_id_started_at_index" ON "ai_runs" USING btree ("project_id","started_at");--> statement-breakpoint
CREATE INDEX "ai_runs_status_index" ON "ai_runs" USING btree ("status");
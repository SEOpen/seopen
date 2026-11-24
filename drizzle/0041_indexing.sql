CREATE TABLE "indexing_pages" (
	"workspace_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"url" text NOT NULL,
	"lastmod" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"inspected_at" timestamp with time zone,
	"verdict" text,
	"coverage_state" text,
	"robots_txt_state" text,
	"indexing_state" text,
	"page_fetch_state" text,
	"last_crawl_time" timestamp with time zone,
	"google_canonical" text,
	"inspection_link" text,
	"indexed_at" timestamp with time zone,
	"submitted_lastmod" text,
	"submitted_at" timestamp with time zone,
	CONSTRAINT "indexing_pages_project_id_url_pk" PRIMARY KEY("project_id","url")
);
--> statement-breakpoint
CREATE TABLE "indexing_settings" (
	"workspace_id" integer NOT NULL,
	"project_id" integer PRIMARY KEY NOT NULL,
	"indexnow_key" text NOT NULL,
	"indexnow_enabled" boolean DEFAULT false NOT NULL,
	"indexnow_host" text,
	"indexnow_verified_at" timestamp with time zone,
	"indexnow_checked_at" timestamp with time zone,
	"indexnow_error" text,
	"last_submit_at" timestamp with time zone,
	"last_submit_count" integer,
	"last_submit_status" integer,
	"sitemap_url" text,
	"sitemap_read_at" timestamp with time zone,
	"sitemap_error" text,
	"sitemap_pages" integer,
	"inspected_at" timestamp with time zone,
	"inspect_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "indexing_pages" ADD CONSTRAINT "indexing_pages_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexing_settings" ADD CONSTRAINT "indexing_settings_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "indexing_pages_project_id_inspected_at_index" ON "indexing_pages" USING btree ("project_id","inspected_at");--> statement-breakpoint
CREATE INDEX "indexing_pages_workspace_project_idx" ON "indexing_pages" USING btree ("workspace_id","project_id");--> statement-breakpoint
CREATE INDEX "indexing_settings_workspace_project_idx" ON "indexing_settings" USING btree ("workspace_id","project_id");
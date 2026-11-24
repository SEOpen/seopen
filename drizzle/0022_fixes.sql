CREATE TABLE "fixes" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"source" text NOT NULL,
	"code" text NOT NULL,
	"url" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"detail" text,
	"evidence" jsonb,
	"page_impressions" integer DEFAULT 0 NOT NULL,
	"last_seen_crawl_id" integer,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"applied_via" text,
	"applied_commit" text,
	"applied_note" text,
	"applied_files" jsonb,
	"before" jsonb,
	"live_at" timestamp with time zone,
	"live_check" jsonb,
	"recrawled_at" timestamp with time zone,
	"inspected_at" timestamp with time zone,
	"results" jsonb,
	"resolved_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"dismissed_reason" text,
	"reopened_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fixes" ADD CONSTRAINT "fixes_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fixes_one_per_finding" ON "fixes" USING btree ("project_id","source","code","url");--> statement-breakpoint
CREATE INDEX "fixes_project_id_status_page_impressions_index" ON "fixes" USING btree ("project_id","status","page_impressions");--> statement-breakpoint
CREATE INDEX "fixes_in_progress" ON "fixes" USING btree ("status") WHERE status in ('applied', 'live');--> statement-breakpoint
CREATE INDEX "fixes_workspace_project_idx" ON "fixes" USING btree ("workspace_id","project_id");
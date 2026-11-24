CREATE TABLE "local_businesses" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"query" text NOT NULL,
	"city" text NOT NULL,
	"title" text NOT NULL,
	"address" text,
	"category" text,
	"domain" text,
	"phone" text,
	"rating" real,
	"votes" integer,
	"cid" text,
	"place_id" text,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"grid_size" smallint DEFAULT 5 NOT NULL,
	"radius_km" smallint DEFAULT 8 NOT NULL,
	"scheduled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_businesses_workspace_id_id_key" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "local_checks" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"business_id" integer NOT NULL,
	"kind" text NOT NULL,
	"grid_size" smallint NOT NULL,
	"radius_km" smallint NOT NULL,
	"zoom" smallint NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"status" text DEFAULT 'posting' NOT NULL,
	"tasks_total" integer DEFAULT 0 NOT NULL,
	"tasks_done" integer DEFAULT 0 NOT NULL,
	"tasks_failed" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "local_checks_workspace_id_id_key" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "local_keywords" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"business_id" integer NOT NULL,
	"keyword" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_points" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"check_id" integer NOT NULL,
	"keyword_id" integer NOT NULL,
	"row" smallint NOT NULL,
	"col" smallint NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"task_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"rank" smallint,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"posted_at" timestamp with time zone,
	"fetched_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ai_prompts" ADD COLUMN "topic" text;--> statement-breakpoint
ALTER TABLE "local_businesses" ADD CONSTRAINT "local_businesses_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_checks" ADD CONSTRAINT "local_checks_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_checks" ADD CONSTRAINT "local_checks_business_parent_fk" FOREIGN KEY ("workspace_id","business_id") REFERENCES "public"."local_businesses"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_keywords" ADD CONSTRAINT "local_keywords_parent_fk" FOREIGN KEY ("workspace_id","business_id") REFERENCES "public"."local_businesses"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_points" ADD CONSTRAINT "local_points_keyword_id_local_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."local_keywords"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_points" ADD CONSTRAINT "local_points_parent_fk" FOREIGN KEY ("workspace_id","check_id") REFERENCES "public"."local_checks"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "local_businesses_project_id_created_at_index" ON "local_businesses" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "local_businesses_workspace_project_idx" ON "local_businesses" USING btree ("workspace_id","project_id");--> statement-breakpoint
CREATE INDEX "local_checks_business_id_created_at_index" ON "local_checks" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "local_checks_status_index" ON "local_checks" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "local_checks_one_active_per_business" ON "local_checks" USING btree ("business_id") WHERE "local_checks"."status" in ('posting', 'pending');--> statement-breakpoint
CREATE INDEX "local_checks_workspace_project_idx" ON "local_checks" USING btree ("workspace_id","project_id");--> statement-breakpoint
CREATE INDEX "local_checks_business_workspace_parent_idx" ON "local_checks" USING btree ("workspace_id","business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "local_keywords_business_id_keyword_index" ON "local_keywords" USING btree ("business_id","keyword");--> statement-breakpoint
CREATE INDEX "local_keywords_workspace_parent_idx" ON "local_keywords" USING btree ("workspace_id","business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "local_points_check_id_keyword_id_row_col_index" ON "local_points" USING btree ("check_id","keyword_id","row","col");--> statement-breakpoint
CREATE UNIQUE INDEX "local_points_task_id_index" ON "local_points" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "local_points_status_posted_at_index" ON "local_points" USING btree ("status","posted_at");--> statement-breakpoint
CREATE INDEX "local_points_keyword_id_index" ON "local_points" USING btree ("keyword_id");--> statement-breakpoint
CREATE INDEX "local_points_workspace_parent_idx" ON "local_points" USING btree ("workspace_id","check_id");
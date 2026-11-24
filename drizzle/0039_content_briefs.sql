CREATE TABLE "content_briefs" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"keyword" text NOT NULL,
	"page_type" text NOT NULL,
	"brief" jsonb NOT NULL,
	"fill" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credits_spent" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content_briefs" ADD CONSTRAINT "content_briefs_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_briefs_project_id_created_at_index" ON "content_briefs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "content_briefs_workspace_project_idx" ON "content_briefs" USING btree ("workspace_id","project_id");
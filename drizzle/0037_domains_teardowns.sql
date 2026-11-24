CREATE TABLE "domains_teardowns" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"domain" text NOT NULL,
	"location_code" integer NOT NULL,
	"language_code" text NOT NULL,
	"summary" text NOT NULL,
	"findings" jsonb NOT NULL,
	"moves" jsonb NOT NULL,
	"credits_spent" integer DEFAULT 0 NOT NULL,
	"saved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "domains_teardowns" ADD CONSTRAINT "domains_teardowns_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "domains_teardowns_project_id_created_at_index" ON "domains_teardowns" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "domains_teardowns_workspace_project_idx" ON "domains_teardowns" USING btree ("workspace_id","project_id");
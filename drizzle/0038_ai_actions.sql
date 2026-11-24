CREATE TABLE "ai_actions" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"prompt_id" integer NOT NULL,
	"kind" text NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"saved_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_prompt_id_ai_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."ai_prompts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_actions_project_id_prompt_id_kind_url_index" ON "ai_actions" USING btree ("project_id","prompt_id","kind","url");--> statement-breakpoint
CREATE INDEX "ai_actions_prompt_id_index" ON "ai_actions" USING btree ("prompt_id");--> statement-breakpoint
CREATE INDEX "ai_actions_workspace_project_idx" ON "ai_actions" USING btree ("workspace_id","project_id");
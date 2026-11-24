CREATE TABLE "plausible_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"api_key_enc" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "plausible_site" text;--> statement-breakpoint
ALTER TABLE "plausible_accounts" ADD CONSTRAINT "plausible_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plausible_accounts_workspace_id_key" ON "plausible_accounts" USING btree ("workspace_id");
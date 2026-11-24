CREATE TABLE "umami_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"base_url" text,
	"auth_type" text NOT NULL,
	"credential_enc" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "umami_site" text;--> statement-breakpoint
ALTER TABLE "umami_accounts" ADD CONSTRAINT "umami_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "umami_accounts_workspace_id_key" ON "umami_accounts" USING btree ("workspace_id");
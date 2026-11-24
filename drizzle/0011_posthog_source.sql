CREATE TABLE "posthog_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"region" text NOT NULL,
	"access_token_enc" text NOT NULL,
	"refresh_token_enc" text,
	"access_token_expires_at" timestamp with time zone NOT NULL,
	"scopes" text[] NOT NULL,
	"scoped_teams" integer[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_refresh_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "posthog_project" text;--> statement-breakpoint
ALTER TABLE "posthog_accounts" ADD CONSTRAINT "posthog_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "posthog_accounts_workspace_id_key" ON "posthog_accounts" USING btree ("workspace_id");
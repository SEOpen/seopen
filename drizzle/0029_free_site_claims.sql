CREATE TABLE "free_site_claims" (
	"hash" text PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "free_site_claims" ADD CONSTRAINT "free_site_claims_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "free_site_claims_workspace_id_index" ON "free_site_claims" USING btree ("workspace_id");
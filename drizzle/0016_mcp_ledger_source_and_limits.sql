CREATE TABLE "api_key_usage" (
	"key_id" integer NOT NULL,
	"workspace_id" integer NOT NULL,
	"bucket" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "api_key_usage_key_id_bucket_window_start_pk" PRIMARY KEY("key_id","bucket","window_start")
);
--> statement-breakpoint
ALTER TABLE "api_ledger" ADD COLUMN "source" text DEFAULT 'app' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_key_usage" ADD CONSTRAINT "api_key_usage_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_usage" ADD CONSTRAINT "api_key_usage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_key_usage_workspace_id_index" ON "api_key_usage" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "api_key_usage_window_start_index" ON "api_key_usage" USING btree ("window_start");
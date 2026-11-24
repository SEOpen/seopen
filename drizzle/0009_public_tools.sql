CREATE TABLE "public_tool_results" (
	"key" text PRIMARY KEY NOT NULL,
	"tool" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "public_tool_uses" (
	"id" serial PRIMARY KEY NOT NULL,
	"tool" text NOT NULL,
	"ip_hash" text NOT NULL,
	"input" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "public_tool_uses_tool_created_at_index" ON "public_tool_uses" USING btree ("tool","created_at");--> statement-breakpoint
CREATE INDEX "public_tool_uses_ip_hash_created_at_index" ON "public_tool_uses" USING btree ("ip_hash","created_at");
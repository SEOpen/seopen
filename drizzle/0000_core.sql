CREATE TABLE "api_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"endpoint" text NOT NULL,
	"response" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'dataforseo' NOT NULL,
	"endpoint" text NOT NULL,
	"module" text NOT NULL,
	"project_id" integer,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"tasks" integer DEFAULT 1 NOT NULL,
	"status_code" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitors" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"domain" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"location_code" integer DEFAULT 2840 NOT NULL,
	"language_code" text DEFAULT 'en' NOT NULL,
	"gsc_property" text,
	"ga4_property" text,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_ledger" ADD CONSTRAINT "api_ledger_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_cache_expires_at_index" ON "api_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "api_ledger_created_at_index" ON "api_ledger" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "api_ledger_module_index" ON "api_ledger" USING btree ("module");--> statement-breakpoint
CREATE UNIQUE INDEX "competitors_project_id_domain_index" ON "competitors" USING btree ("project_id","domain");
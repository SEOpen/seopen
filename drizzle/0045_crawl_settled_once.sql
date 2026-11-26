ALTER TABLE "audit_crawls" ADD COLUMN "cost_settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "audit_crawls" ADD COLUMN "import_attempts" integer DEFAULT 0 NOT NULL;
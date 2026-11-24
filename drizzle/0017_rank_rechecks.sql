DROP INDEX "rank_tasks_run_id_keyword_id_index";--> statement-breakpoint
ALTER TABLE "rank_results" ADD COLUMN "not_checked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rank_runs" ADD COLUMN "rechecks" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "rank_runs" ADD COLUMN "not_checked" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "rank_tasks" ADD COLUMN "attempt" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "rank_tasks" ADD COLUMN "look" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "rank_tasks_run_id_keyword_id_attempt_index" ON "rank_tasks" USING btree ("run_id","keyword_id","attempt");
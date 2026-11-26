-- Two starts at once could each make a run for one project. Before the index allows only one in
-- progress, close the extra ones: the oldest stays, as the one a job picked up first. A closed
-- run's job finds it closed and does nothing.
UPDATE "ai_runs" SET "status" = 'failed', "error" = 'None of this run''s answers came back', "finished_at" = now()
WHERE "status" in ('queued', 'running')
  AND "id" NOT IN (SELECT min("id") FROM "ai_runs" WHERE "status" in ('queued', 'running') GROUP BY "project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_runs_one_active_per_project" ON "ai_runs" USING btree ("project_id") WHERE status in ('queued', 'running');
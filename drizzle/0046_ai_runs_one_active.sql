-- Two starts at once could each make a run for one project. Before the index allows only one in
-- progress, close the extra ones: the one already running stays, else the oldest, as the one a job
-- picked up first. A closed run's job finds it closed and does nothing, so what it never sent is
-- closed with it; what it did send is left for the poll to read.
UPDATE "ai_runs" SET "status" = 'failed', "error" = 'None of this run''s answers came back', "finished_at" = now()
WHERE "status" in ('queued', 'running')
  AND "id" NOT IN (
    SELECT DISTINCT ON ("project_id") "id" FROM "ai_runs" WHERE "status" in ('queued', 'running')
    ORDER BY "project_id", ("status" = 'running') DESC, "id"
  );--> statement-breakpoint
UPDATE "ai_results" r SET "status" = 'failed', "error" = 'Run stopped before this task was posted', "completed_at" = now()
FROM "ai_runs" a WHERE a."id" = r."run_id" AND a."status" = 'failed' AND r."status" = 'pending' AND r."task_id" IS NULL;--> statement-breakpoint
UPDATE "ai_overviews" o SET "status" = 'failed', "error" = 'Run stopped before this task was posted', "completed_at" = now()
FROM "ai_runs" a WHERE a."id" = o."run_id" AND a."status" = 'failed' AND o."status" = 'pending' AND o."task_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_runs_one_active_per_project" ON "ai_runs" USING btree ("project_id") WHERE status in ('queued', 'running');
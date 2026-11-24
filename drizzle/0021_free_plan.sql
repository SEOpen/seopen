ALTER TABLE "workspaces" ALTER COLUMN "plan" SET DEFAULT 'free';--> statement-breakpoint
-- A workspace with no subscription is on the Free plan now. Paid, trial and internal workspaces keep theirs.
UPDATE "workspaces" SET "plan" = 'free' WHERE "plan" = 'none';

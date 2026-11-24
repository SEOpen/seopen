ALTER TABLE "users" ADD COLUMN "welcome_email_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_usage" ADD COLUMN "limit_email_at" timestamp with time zone;--> statement-breakpoint
-- Anyone who has already signed in isn't new, so their next sign-in doesn't welcome them. An invite not used yet has no account row and still gets it.
UPDATE "users" SET "welcome_email_at" = now() WHERE "id" IN (SELECT "user_id" FROM "accounts");

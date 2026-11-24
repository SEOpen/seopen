ALTER TABLE "users" ADD COLUMN "first_source" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "first_referrer_host" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "first_landing_path" text;
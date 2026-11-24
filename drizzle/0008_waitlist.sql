CREATE TABLE "waitlist" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"site" text,
	"heard_from" text,
	"heard_from_other" text,
	"from_path" text,
	"referrer" text,
	"utm_source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invited_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_email_key" ON "waitlist" USING btree ("email");
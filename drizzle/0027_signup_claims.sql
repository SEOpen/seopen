CREATE TABLE "signup_claims" (
	"hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone
);

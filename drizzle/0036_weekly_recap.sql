CREATE TABLE "recap_sends" (
	"workspace_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"week" date NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recap_sends_workspace_id_user_id_week_pk" PRIMARY KEY("workspace_id","user_id","week")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "weekly_recap" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "recap_sends" ADD CONSTRAINT "recap_sends_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recap_sends" ADD CONSTRAINT "recap_sends_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recap_sends_user_id_index" ON "recap_sends" USING btree ("user_id");
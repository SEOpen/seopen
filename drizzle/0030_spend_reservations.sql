CREATE TABLE "spend_reservations" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"month" date NOT NULL,
	"estimate_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"research" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spend_reservations" ADD CONSTRAINT "spend_reservations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spend_reservations_workspace_id_index" ON "spend_reservations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "spend_reservations_created_at_index" ON "spend_reservations" USING btree ("created_at");
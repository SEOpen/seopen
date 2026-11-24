CREATE TABLE "alert_rules" (
	"workspace_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"rule" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_rules_project_id_rule_pk" PRIMARY KEY("project_id","rule")
);
--> statement-breakpoint
CREATE TABLE "alert_sends" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"rule" text NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"source" text NOT NULL,
	"screen" text NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"send_id" integer
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "alert_emails" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_sends" ADD CONSTRAINT "alert_sends_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_rules_workspace_project_idx" ON "alert_rules" USING btree ("workspace_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "alert_sends_project_id_day_kind_index" ON "alert_sends" USING btree ("project_id","day","kind");--> statement-breakpoint
CREATE INDEX "alert_sends_workspace_project_idx" ON "alert_sends" USING btree ("workspace_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_one_open_per_key" ON "alerts" USING btree ("project_id","rule","key") WHERE "alerts"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "alerts_project_id_detected_at_index" ON "alerts" USING btree ("project_id","detected_at");--> statement-breakpoint
CREATE INDEX "alerts_send_id_index" ON "alerts" USING btree ("send_id");--> statement-breakpoint
CREATE INDEX "alerts_workspace_project_idx" ON "alerts" USING btree ("workspace_id","project_id");
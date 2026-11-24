CREATE TABLE "dfs_places" (
	"code" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"country_iso" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "city_code" integer;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "city_name" text;--> statement-breakpoint
ALTER TABLE "rank_results" ADD COLUMN "location_code" integer;--> statement-breakpoint
ALTER TABLE "rank_runs" ADD COLUMN "location_code" integer;--> statement-breakpoint
CREATE INDEX "dfs_places_country_iso_name_index" ON "dfs_places" USING btree ("country_iso","name");--> statement-breakpoint
UPDATE "rank_runs" r SET "location_code" = p."location_code" FROM "projects" p WHERE p."id" = r."project_id" AND p."workspace_id" = r."workspace_id";--> statement-breakpoint
UPDATE "rank_results" r SET "location_code" = p."location_code" FROM "projects" p WHERE p."id" = r."project_id" AND p."workspace_id" = r."workspace_id";

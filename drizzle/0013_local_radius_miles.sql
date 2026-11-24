ALTER TABLE "local_checks" ALTER COLUMN "radius_km" SET DEFAULT 8;--> statement-breakpoint
ALTER TABLE "local_businesses" ADD COLUMN "radius_miles" smallint DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "local_checks" ADD COLUMN "radius_miles" smallint DEFAULT 5 NOT NULL;--> statement-breakpoint
-- The offered radii were 2, 5, 8 and 15 km; they become 1, 3, 5 and 10 miles.
UPDATE "local_businesses" SET "radius_miles" = CASE "radius_km" WHEN 2 THEN 1 WHEN 5 THEN 3 WHEN 8 THEN 5 WHEN 15 THEN 10 ELSE GREATEST(1, round("radius_km" / 1.609344)) END;--> statement-breakpoint
UPDATE "local_checks" SET "radius_miles" = CASE "radius_km" WHEN 2 THEN 1 WHEN 5 THEN 3 WHEN 8 THEN 5 WHEN 15 THEN 10 ELSE GREATEST(1, round("radius_km" / 1.609344)) END;

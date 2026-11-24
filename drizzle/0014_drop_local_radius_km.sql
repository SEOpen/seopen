ALTER TABLE "local_checks" ALTER COLUMN "radius_miles" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "local_businesses" DROP COLUMN "radius_km";--> statement-breakpoint
ALTER TABLE "local_checks" DROP COLUMN "radius_km";
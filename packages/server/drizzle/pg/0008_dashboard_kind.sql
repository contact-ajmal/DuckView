ALTER TABLE "dashboards" ADD COLUMN "kind" text DEFAULT 'grid' NOT NULL;--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "spec" jsonb;
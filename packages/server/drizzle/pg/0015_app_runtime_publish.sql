ALTER TABLE "data_apps" ADD COLUMN "always_on" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "data_apps" ADD COLUMN "runtime" text;--> statement-breakpoint
ALTER TABLE "data_apps" ADD COLUMN "publish_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "data_apps" ADD COLUMN "publish_requested_by" text;--> statement-breakpoint
ALTER TABLE "data_apps" ADD COLUMN "publish_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "data_apps" ADD COLUMN "publish_reviewed_by" text;--> statement-breakpoint
ALTER TABLE "data_apps" ADD COLUMN "publish_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "data_apps" ADD COLUMN "publish_note" text;--> statement-breakpoint
UPDATE "data_apps" SET "publish_status" = 'approved' WHERE "visibility" = 'org';
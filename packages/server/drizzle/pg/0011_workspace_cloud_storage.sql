ALTER TABLE "workspaces" ADD COLUMN "cloud_connection_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "cloud_sync" jsonb;
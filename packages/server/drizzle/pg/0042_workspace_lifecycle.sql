CREATE TABLE "workspace_backups" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"file" text NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"tables" integer DEFAULT 0 NOT NULL,
	"objects" jsonb DEFAULT '{"queries":0,"dashboards":0,"notebooks":0,"quality":0}'::jsonb NOT NULL,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "backup_policy" jsonb;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "last_backup_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "idle_warned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_backups" ADD CONSTRAINT "workspace_backups_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_backups_ws_idx" ON "workspace_backups" USING btree ("workspace_id","created_at");
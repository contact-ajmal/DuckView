CREATE TABLE "snapshot_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot_id" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"format" text NOT NULL,
	"file" text,
	"bytes" integer,
	"delivered" integer DEFAULT 0 NOT NULL,
	"triggered_by" text DEFAULT 'schedule' NOT NULL,
	"duration_ms" integer,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"target" jsonb NOT NULL,
	"format" text DEFAULT 'png' NOT NULL,
	"width" integer DEFAULT 1280 NOT NULL,
	"schedule" jsonb NOT NULL,
	"channel_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_status" text,
	"last_error" text,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "snapshot_runs" ADD CONSTRAINT "snapshot_runs_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "snapshot_runs_snapshot_idx" ON "snapshot_runs" USING btree ("snapshot_id","created_at");--> statement-breakpoint
CREATE INDEX "snapshots_workspace_idx" ON "snapshots" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "snapshots_next_run_idx" ON "snapshots" USING btree ("next_run_at");
CREATE TABLE "reverse_sync_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"sync_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"status" text NOT NULL,
	"triggered_by" text NOT NULL,
	"actor_id" text,
	"rows_read" integer,
	"rows_sent" integer,
	"rows_deleted" integer,
	"summary" text,
	"error" text,
	"duration_ms" integer,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reverse_syncs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"sql" text NOT NULL,
	"destination" jsonb NOT NULL,
	"mode" text DEFAULT 'replace' NOT NULL,
	"key_columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"encrypted_secret" text,
	"iv" text,
	"tag" text,
	"schedule" jsonb DEFAULT '{"kind":"manual"}'::jsonb NOT NULL,
	"channel_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run" jsonb,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reverse_sync_runs" ADD CONSTRAINT "reverse_sync_runs_sync_id_reverse_syncs_id_fk" FOREIGN KEY ("sync_id") REFERENCES "public"."reverse_syncs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reverse_syncs" ADD CONSTRAINT "reverse_syncs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reverse_syncs" ADD CONSTRAINT "reverse_syncs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reverse_sync_runs_sync_idx" ON "reverse_sync_runs" USING btree ("sync_id","started_at");--> statement-breakpoint
CREATE INDEX "reverse_syncs_workspace_idx" ON "reverse_syncs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "reverse_syncs_next_run_idx" ON "reverse_syncs" USING btree ("next_run_at");
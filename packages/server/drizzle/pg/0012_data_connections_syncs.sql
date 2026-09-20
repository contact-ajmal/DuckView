CREATE TABLE "data_sync_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"sync_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"status" text NOT NULL,
	"triggered_by" text NOT NULL,
	"actor_id" text,
	"rows" integer,
	"duration_ms" integer,
	"error" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "data_syncs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"source" jsonb NOT NULL,
	"target_schema" text DEFAULT 'main' NOT NULL,
	"target_table" text NOT NULL,
	"mode" text DEFAULT 'replace' NOT NULL,
	"transform_sql" text,
	"schedule" jsonb DEFAULT '{"kind":"manual"}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run" jsonb,
	"next_run_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "database_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"engine" text NOT NULL,
	"alias" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"encrypted_credentials" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"last_error" text,
	"last_tested_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "data_sync_runs" ADD CONSTRAINT "data_sync_runs_sync_id_data_syncs_id_fk" FOREIGN KEY ("sync_id") REFERENCES "public"."data_syncs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_syncs" ADD CONSTRAINT "data_syncs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_syncs" ADD CONSTRAINT "data_syncs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_connections" ADD CONSTRAINT "database_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_sync_runs_sync_idx" ON "data_sync_runs" USING btree ("sync_id","started_at");--> statement-breakpoint
CREATE INDEX "data_syncs_workspace_idx" ON "data_syncs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "data_syncs_next_run_idx" ON "data_syncs" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "database_connections_user_idx" ON "database_connections" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "database_connections_alias_idx" ON "database_connections" USING btree ("user_id","alias");
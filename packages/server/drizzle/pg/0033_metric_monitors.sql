CREATE TABLE "insights" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"monitor_id" text NOT NULL,
	"key" text NOT NULL,
	"metric" text NOT NULL,
	"grain" text NOT NULL,
	"period" text NOT NULL,
	"segment" text,
	"direction" text NOT NULL,
	"summary" text NOT NULL,
	"detail" jsonb NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric_monitors" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"metric" text NOT NULL,
	"grain" text DEFAULT 'day' NOT NULL,
	"segment_by" text,
	"sensitivity" integer DEFAULT 3 NOT NULL,
	"lookback" integer DEFAULT 28 NOT NULL,
	"schedule" jsonb DEFAULT '{"kind":"manual"}'::jsonb NOT NULL,
	"channel_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"last_run" jsonb,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_monitor_id_metric_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."metric_monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_monitors" ADD CONSTRAINT "metric_monitors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_monitors" ADD CONSTRAINT "metric_monitors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "insights_key_idx" ON "insights" USING btree ("key");--> statement-breakpoint
CREATE INDEX "insights_workspace_idx" ON "insights" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "metric_monitors_workspace_idx" ON "metric_monitors" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "metric_monitors_next_run_idx" ON "metric_monitors" USING btree ("next_run_at");
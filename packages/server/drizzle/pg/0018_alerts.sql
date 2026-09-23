CREATE TABLE "alert_events" (
	"id" text PRIMARY KEY NOT NULL,
	"alert_id" text NOT NULL,
	"state" text NOT NULL,
	"value" text,
	"message" text,
	"notified" integer DEFAULT 0 NOT NULL,
	"triggered_by" text DEFAULT 'schedule' NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sql" text NOT NULL,
	"condition" jsonb NOT NULL,
	"schedule" jsonb NOT NULL,
	"channel_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"severity" text DEFAULT 'warning' NOT NULL,
	"notify" text DEFAULT 'change' NOT NULL,
	"notify_resolved" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"state" text DEFAULT 'unknown' NOT NULL,
	"last_value" text,
	"last_error" text,
	"last_checked_at" timestamp with time zone,
	"last_triggered_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_events_alert_idx" ON "alert_events" USING btree ("alert_id","created_at");--> statement-breakpoint
CREATE INDEX "alerts_workspace_idx" ON "alerts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "alerts_next_run_idx" ON "alerts" USING btree ("next_run_at");
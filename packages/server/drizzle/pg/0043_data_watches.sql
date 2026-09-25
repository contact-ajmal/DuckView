CREATE TABLE "data_watches" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"target" text NOT NULL,
	"watch_schema" boolean DEFAULT true NOT NULL,
	"max_age_hours" integer,
	"time_column" text,
	"check_every_minutes" integer DEFAULT 60 NOT NULL,
	"channel_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"baseline" jsonb,
	"status" text DEFAULT 'unknown' NOT NULL,
	"detail" text,
	"last_seen_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "data_watches" ADD CONSTRAINT "data_watches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_watches" ADD CONSTRAINT "data_watches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_watches_ws_idx" ON "data_watches" USING btree ("workspace_id");
CREATE TABLE "data_apps" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" text DEFAULT 'streamlit' NOT NULL,
	"entry" text DEFAULT 'app.py' NOT NULL,
	"files" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"spec" jsonb,
	"visibility" text DEFAULT 'workspace' NOT NULL,
	"status" text DEFAULT 'stopped' NOT NULL,
	"port" integer,
	"pid" integer,
	"last_error" text,
	"last_started_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "data_apps" ADD CONSTRAINT "data_apps_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_apps" ADD CONSTRAINT "data_apps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_apps_workspace_idx" ON "data_apps" USING btree ("workspace_id");
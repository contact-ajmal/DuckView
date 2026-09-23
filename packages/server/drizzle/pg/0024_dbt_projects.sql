CREATE TABLE "dbt_projects" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"files" jsonb NOT NULL,
	"vars" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"target_schema" text DEFAULT 'main' NOT NULL,
	"schedule" jsonb DEFAULT '{"kind":"manual"}'::jsonb NOT NULL,
	"scheduled" jsonb DEFAULT '{"command":"build"}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dbt_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text,
	"command" text NOT NULL,
	"select" text,
	"exclude" text,
	"full_refresh" boolean DEFAULT false NOT NULL,
	"triggered_by" text NOT NULL,
	"status" text NOT NULL,
	"summary" text,
	"error" text,
	"log" text,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"duration_ms" integer,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "dbt_projects" ADD CONSTRAINT "dbt_projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dbt_projects" ADD CONSTRAINT "dbt_projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dbt_runs" ADD CONSTRAINT "dbt_runs_project_id_dbt_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."dbt_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dbt_projects_workspace_idx" ON "dbt_projects" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "dbt_projects_next_run_idx" ON "dbt_projects" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "dbt_runs_project_idx" ON "dbt_runs" USING btree ("project_id","started_at");
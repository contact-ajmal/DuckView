CREATE TABLE "quality_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"suite_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"status" text NOT NULL,
	"summary" text NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"triggered_by" text NOT NULL,
	"actor_id" text,
	"notified" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"started_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quality_suites" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"relation" text NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
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
ALTER TABLE "quality_runs" ADD CONSTRAINT "quality_runs_suite_id_quality_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."quality_suites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_suites" ADD CONSTRAINT "quality_suites_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_suites" ADD CONSTRAINT "quality_suites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quality_runs_suite_idx" ON "quality_runs" USING btree ("suite_id","started_at");--> statement-breakpoint
CREATE INDEX "quality_suites_workspace_idx" ON "quality_suites" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "quality_suites_next_run_idx" ON "quality_suites" USING btree ("next_run_at");
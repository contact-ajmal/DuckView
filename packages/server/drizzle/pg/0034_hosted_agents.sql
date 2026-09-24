CREATE TABLE "hosted_agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"status" text NOT NULL,
	"triggered_by" text NOT NULL,
	"actor_id" text,
	"input" text NOT NULL,
	"output" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"model" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"notified" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "hosted_agents" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"template" text,
	"instructions" text NOT NULL,
	"task" text NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_steps" integer DEFAULT 8 NOT NULL,
	"schedule" jsonb DEFAULT '{"kind":"manual"}'::jsonb NOT NULL,
	"channel_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run" jsonb,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hosted_agent_runs" ADD CONSTRAINT "hosted_agent_runs_agent_id_hosted_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."hosted_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosted_agents" ADD CONSTRAINT "hosted_agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosted_agents" ADD CONSTRAINT "hosted_agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hosted_agent_runs_agent_idx" ON "hosted_agent_runs" USING btree ("agent_id","started_at");--> statement-breakpoint
CREATE INDEX "hosted_agents_workspace_idx" ON "hosted_agents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "hosted_agents_next_run_idx" ON "hosted_agents" USING btree ("next_run_at");
CREATE TABLE "copilot_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"base_url" text,
	"encrypted_api_key" text,
	"iv" text,
	"tag" text,
	"key_hint" text,
	"aws_region" text,
	"bedrock_agent_id" text,
	"bedrock_agent_alias_id" text,
	"agentcore_runtime_arn" text,
	"updated_by" text,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "copilot_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"message_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"action" text NOT NULL,
	"byok" boolean DEFAULT false NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"duration_ms" integer NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "copilot_settings" ADD CONSTRAINT "copilot_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_usage" ADD CONSTRAINT "copilot_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_usage" ADD CONSTRAINT "copilot_usage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "copilot_usage_user_idx" ON "copilot_usage" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "copilot_usage_created_idx" ON "copilot_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "copilot_usage_conversation_idx" ON "copilot_usage" USING btree ("conversation_id");
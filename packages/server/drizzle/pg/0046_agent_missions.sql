ALTER TABLE "agent_sessions" ADD COLUMN "mode" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "datasets" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "visibility" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_sessions_ws_idx" ON "agent_sessions" USING btree ("workspace_id","visibility");
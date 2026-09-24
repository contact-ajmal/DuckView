CREATE TABLE "streams" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"config" jsonb NOT NULL,
	"encrypted_secret" text,
	"iv" text,
	"tag" text,
	"key_hash" text,
	"format" text DEFAULT 'json' NOT NULL,
	"target_schema" text DEFAULT 'main' NOT NULL,
	"target_table" text NOT NULL,
	"include_metadata" boolean DEFAULT true NOT NULL,
	"batch_rows" integer DEFAULT 1000 NOT NULL,
	"batch_seconds" integer DEFAULT 5 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'stopped' NOT NULL,
	"stats" jsonb DEFAULT '{"rows_total":0,"batches":0,"last_batch_rows":0,"last_batch_at":null,"last_error":null,"last_error_at":null}'::jsonb NOT NULL,
	"checkpoints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "streams" ADD CONSTRAINT "streams_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "streams" ADD CONSTRAINT "streams_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "streams_workspace_idx" ON "streams" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "streams_target_idx" ON "streams" USING btree ("workspace_id","target_schema","target_table");
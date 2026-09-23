CREATE TABLE "git_syncs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"repo_url" text NOT NULL,
	"branch" text DEFAULT 'main' NOT NULL,
	"path" text DEFAULT '' NOT NULL,
	"encrypted_secret" text,
	"iv" text,
	"tag" text,
	"created_by" text,
	"last_push_sha" text,
	"last_push_at" timestamp with time zone,
	"last_pull_sha" text,
	"last_pull_at" timestamp with time zone,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "git_syncs" ADD CONSTRAINT "git_syncs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "git_syncs_workspace_idx" ON "git_syncs" USING btree ("workspace_id");
CREATE TABLE "notebooks" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"cells" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notebooks" ADD CONSTRAINT "notebooks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebooks" ADD CONSTRAINT "notebooks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notebooks_workspace_idx" ON "notebooks" USING btree ("workspace_id");
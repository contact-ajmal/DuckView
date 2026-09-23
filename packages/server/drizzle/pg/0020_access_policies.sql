CREATE TABLE "access_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"table_name" text NOT NULL,
	"row_filter" text,
	"column_masks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"applies_to" jsonb DEFAULT '{"roles":["VIEWER"]}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_policies" ADD CONSTRAINT "access_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_policies" ADD CONSTRAINT "access_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_policies_workspace_idx" ON "access_policies" USING btree ("workspace_id");
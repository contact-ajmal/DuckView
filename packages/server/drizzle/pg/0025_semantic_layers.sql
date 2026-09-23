CREATE TABLE "semantic_layers" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source" text NOT NULL,
	"yaml" text,
	"definition" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "semantic_layers" ADD CONSTRAINT "semantic_layers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "semantic_layers_source_idx" ON "semantic_layers" USING btree ("workspace_id","source");
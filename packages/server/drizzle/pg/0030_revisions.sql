CREATE TABLE "revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text NOT NULL,
	"number" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"message" text,
	"named" boolean DEFAULT false NOT NULL,
	"user_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "revisions_object_idx" ON "revisions" USING btree ("object_type","object_id","number");
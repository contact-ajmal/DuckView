CREATE TABLE "query_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"sql" text NOT NULL,
	"params" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"public" boolean DEFAULT false NOT NULL,
	"key_hash" text,
	"key_hint" text,
	"max_rows" integer DEFAULT 1000 NOT NULL,
	"rate_per_minute" integer DEFAULT 60 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"last_called_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "query_endpoints" ADD CONSTRAINT "query_endpoints_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "query_endpoints" ADD CONSTRAINT "query_endpoints_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "query_endpoints_slug_idx" ON "query_endpoints" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "query_endpoints_ws_idx" ON "query_endpoints" USING btree ("workspace_id");
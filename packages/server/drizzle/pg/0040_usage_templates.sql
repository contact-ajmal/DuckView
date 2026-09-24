CREATE TABLE "template_installs" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"template_name" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"table_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"objects" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text DEFAULT 'Other' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"author_id" text NOT NULL,
	"status" text NOT NULL,
	"body" jsonb NOT NULL,
	"installs" integer DEFAULT 0 NOT NULL,
	"reviewed_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_budgets" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"workspace_id" text,
	"amount_cents" integer NOT NULL,
	"thresholds" jsonb DEFAULT '[80,100]'::jsonb NOT NULL,
	"forecast" boolean DEFAULT false NOT NULL,
	"channel_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notified" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "template_installs" ADD CONSTRAINT "template_installs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_budgets" ADD CONSTRAINT "usage_budgets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "template_installs_ws_idx" ON "template_installs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "templates_status_idx" ON "templates" USING btree ("status");--> statement-breakpoint
CREATE INDEX "templates_author_idx" ON "templates" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "usage_budgets_workspace_idx" ON "usage_budgets" USING btree ("workspace_id");
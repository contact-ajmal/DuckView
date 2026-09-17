CREATE TABLE "lakehouse_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"alias" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"encrypted_credentials" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"last_error" text,
	"last_tested_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_tabs" ADD COLUMN "engine" text;--> statement-breakpoint
ALTER TABLE "lakehouse_connections" ADD CONSTRAINT "lakehouse_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lakehouse_connections_user_idx" ON "lakehouse_connections" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lakehouse_connections_alias_idx" ON "lakehouse_connections" USING btree ("user_id","alias");
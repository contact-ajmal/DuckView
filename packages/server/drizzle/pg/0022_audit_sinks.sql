CREATE TABLE "audit_sinks" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"encrypted_secret" text,
	"iv" text,
	"tag" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"cursor_at" timestamp with time zone,
	"cursor_id" text,
	"exported" integer DEFAULT 0 NOT NULL,
	"last_status" text,
	"last_error" text,
	"last_exported_at" timestamp with time zone,
	"retry_after" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_sinks" ADD CONSTRAINT "audit_sinks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
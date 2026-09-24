CREATE TABLE "a2a_remotes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"card_url" text NOT NULL,
	"endpoint" text NOT NULL,
	"card" jsonb NOT NULL,
	"encrypted_headers" text,
	"iv" text,
	"tag" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hosted_agent_runs" ADD COLUMN "context_id" text;--> statement-breakpoint
ALTER TABLE "a2a_remotes" ADD CONSTRAINT "a2a_remotes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "a2a_remotes_user_idx" ON "a2a_remotes" USING btree ("user_id");
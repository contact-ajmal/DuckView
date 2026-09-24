CREATE TABLE "orchestration_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"kind" text NOT NULL,
	"target_id" text,
	"label" text NOT NULL,
	"status" text NOT NULL,
	"summary" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text DEFAULT 'api' NOT NULL,
	"external_run_id" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "orchestration_runs" ADD CONSTRAINT "orchestration_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orchestration_runs_user_idx" ON "orchestration_runs" USING btree ("user_id","started_at");
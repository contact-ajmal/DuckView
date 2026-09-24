ALTER TABLE "streams" ADD COLUMN "mode" text DEFAULT 'append' NOT NULL;--> statement-breakpoint
ALTER TABLE "streams" ADD COLUMN "key_columns" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "streams" ADD COLUMN "keep_history" boolean DEFAULT false NOT NULL;
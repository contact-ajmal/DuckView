ALTER TABLE `streams` ADD `mode` text DEFAULT 'append' NOT NULL;--> statement-breakpoint
ALTER TABLE `streams` ADD `key_columns` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `streams` ADD `keep_history` integer DEFAULT false NOT NULL;
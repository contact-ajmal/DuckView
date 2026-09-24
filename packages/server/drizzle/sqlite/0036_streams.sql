CREATE TABLE `streams` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`config` text NOT NULL,
	`encrypted_secret` text,
	`iv` text,
	`tag` text,
	`key_hash` text,
	`format` text DEFAULT 'json' NOT NULL,
	`target_schema` text DEFAULT 'main' NOT NULL,
	`target_table` text NOT NULL,
	`include_metadata` integer DEFAULT true NOT NULL,
	`batch_rows` integer DEFAULT 1000 NOT NULL,
	`batch_seconds` integer DEFAULT 5 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'stopped' NOT NULL,
	`stats` text DEFAULT '{"rows_total":0,"batches":0,"last_batch_rows":0,"last_batch_at":null,"last_error":null,"last_error_at":null}' NOT NULL,
	`checkpoints` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `streams_workspace_idx` ON `streams` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `streams_target_idx` ON `streams` (`workspace_id`,`target_schema`,`target_table`);
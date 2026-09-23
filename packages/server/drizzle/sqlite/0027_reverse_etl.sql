CREATE TABLE `reverse_sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`sync_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`status` text NOT NULL,
	`triggered_by` text NOT NULL,
	`actor_id` text,
	`rows_read` integer,
	`rows_sent` integer,
	`rows_deleted` integer,
	`summary` text,
	`error` text,
	`duration_ms` integer,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`sync_id`) REFERENCES `reverse_syncs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reverse_sync_runs_sync_idx` ON `reverse_sync_runs` (`sync_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `reverse_syncs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`sql` text NOT NULL,
	`destination` text NOT NULL,
	`mode` text DEFAULT 'replace' NOT NULL,
	`key_columns` text DEFAULT '[]' NOT NULL,
	`encrypted_secret` text,
	`iv` text,
	`tag` text,
	`schedule` text DEFAULT '{"kind":"manual"}' NOT NULL,
	`channel_ids` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_run` text,
	`next_run_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reverse_syncs_workspace_idx` ON `reverse_syncs` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `reverse_syncs_next_run_idx` ON `reverse_syncs` (`next_run_at`);
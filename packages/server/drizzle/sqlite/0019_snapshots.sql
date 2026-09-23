CREATE TABLE `snapshot_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`format` text NOT NULL,
	`file` text,
	`bytes` integer,
	`delivered` integer DEFAULT 0 NOT NULL,
	`triggered_by` text DEFAULT 'schedule' NOT NULL,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `snapshot_runs_snapshot_idx` ON `snapshot_runs` (`snapshot_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`target` text NOT NULL,
	`format` text DEFAULT 'png' NOT NULL,
	`width` integer DEFAULT 1280 NOT NULL,
	`schedule` text NOT NULL,
	`channel_ids` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_status` text,
	`last_error` text,
	`last_run_at` integer,
	`next_run_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `snapshots_workspace_idx` ON `snapshots` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `snapshots_next_run_idx` ON `snapshots` (`next_run_at`);
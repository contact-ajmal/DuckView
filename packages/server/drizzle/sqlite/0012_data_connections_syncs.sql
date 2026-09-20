CREATE TABLE `data_sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`sync_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`status` text NOT NULL,
	`triggered_by` text NOT NULL,
	`actor_id` text,
	`rows` integer,
	`duration_ms` integer,
	`error` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`sync_id`) REFERENCES `data_syncs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `data_sync_runs_sync_idx` ON `data_sync_runs` (`sync_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `data_syncs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`target_schema` text DEFAULT 'main' NOT NULL,
	`target_table` text NOT NULL,
	`mode` text DEFAULT 'replace' NOT NULL,
	`transform_sql` text,
	`schedule` text DEFAULT '{"kind":"manual"}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_run` text,
	`next_run_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `data_syncs_workspace_idx` ON `data_syncs` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `data_syncs_next_run_idx` ON `data_syncs` (`next_run_at`);--> statement-breakpoint
CREATE TABLE `database_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`engine` text NOT NULL,
	`alias` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`encrypted_credentials` text NOT NULL,
	`iv` text NOT NULL,
	`tag` text NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`last_error` text,
	`last_tested_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `database_connections_user_idx` ON `database_connections` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `database_connections_alias_idx` ON `database_connections` (`user_id`,`alias`);
CREATE TABLE `insights` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`monitor_id` text NOT NULL,
	`key` text NOT NULL,
	`metric` text NOT NULL,
	`grain` text NOT NULL,
	`period` text NOT NULL,
	`segment` text,
	`direction` text NOT NULL,
	`summary` text NOT NULL,
	`detail` text NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`monitor_id`) REFERENCES `metric_monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `insights_key_idx` ON `insights` (`key`);--> statement-breakpoint
CREATE INDEX `insights_workspace_idx` ON `insights` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `metric_monitors` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`metric` text NOT NULL,
	`grain` text DEFAULT 'day' NOT NULL,
	`segment_by` text,
	`sensitivity` integer DEFAULT 3 NOT NULL,
	`lookback` integer DEFAULT 28 NOT NULL,
	`schedule` text DEFAULT '{"kind":"manual"}' NOT NULL,
	`channel_ids` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`last_run` text,
	`next_run_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `metric_monitors_workspace_idx` ON `metric_monitors` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `metric_monitors_next_run_idx` ON `metric_monitors` (`next_run_at`);
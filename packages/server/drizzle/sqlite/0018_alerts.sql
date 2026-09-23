CREATE TABLE `alert_events` (
	`id` text PRIMARY KEY NOT NULL,
	`alert_id` text NOT NULL,
	`state` text NOT NULL,
	`value` text,
	`message` text,
	`notified` integer DEFAULT 0 NOT NULL,
	`triggered_by` text DEFAULT 'schedule' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `alert_events_alert_idx` ON `alert_events` (`alert_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`sql` text NOT NULL,
	`condition` text NOT NULL,
	`schedule` text NOT NULL,
	`channel_ids` text DEFAULT '[]' NOT NULL,
	`severity` text DEFAULT 'warning' NOT NULL,
	`notify` text DEFAULT 'change' NOT NULL,
	`notify_resolved` integer DEFAULT true NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`state` text DEFAULT 'unknown' NOT NULL,
	`last_value` text,
	`last_error` text,
	`last_checked_at` integer,
	`last_triggered_at` integer,
	`next_run_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `alerts_workspace_idx` ON `alerts` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `alerts_next_run_idx` ON `alerts` (`next_run_at`);
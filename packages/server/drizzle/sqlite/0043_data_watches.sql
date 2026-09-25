CREATE TABLE `data_watches` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`target` text NOT NULL,
	`watch_schema` integer DEFAULT true NOT NULL,
	`max_age_hours` integer,
	`time_column` text,
	`check_every_minutes` integer DEFAULT 60 NOT NULL,
	`channel_ids` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`baseline` text,
	`status` text DEFAULT 'unknown' NOT NULL,
	`detail` text,
	`last_seen_at` integer,
	`last_checked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `data_watches_ws_idx` ON `data_watches` (`workspace_id`);
CREATE TABLE `query_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`sql` text NOT NULL,
	`params` text DEFAULT '[]' NOT NULL,
	`public` integer DEFAULT false NOT NULL,
	`key_hash` text,
	`key_hint` text,
	`max_rows` integer DEFAULT 1000 NOT NULL,
	`rate_per_minute` integer DEFAULT 60 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`last_called_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `query_endpoints_slug_idx` ON `query_endpoints` (`slug`);--> statement-breakpoint
CREATE INDEX `query_endpoints_ws_idx` ON `query_endpoints` (`workspace_id`);
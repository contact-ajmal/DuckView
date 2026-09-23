CREATE TABLE `quality_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`suite_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`status` text NOT NULL,
	`summary` text NOT NULL,
	`results` text DEFAULT '[]' NOT NULL,
	`triggered_by` text NOT NULL,
	`actor_id` text,
	`notified` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer,
	`started_at` integer NOT NULL,
	FOREIGN KEY (`suite_id`) REFERENCES `quality_suites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `quality_runs_suite_idx` ON `quality_runs` (`suite_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `quality_suites` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`relation` text NOT NULL,
	`checks` text DEFAULT '[]' NOT NULL,
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
CREATE INDEX `quality_suites_workspace_idx` ON `quality_suites` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `quality_suites_next_run_idx` ON `quality_suites` (`next_run_at`);
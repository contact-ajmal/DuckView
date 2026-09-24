CREATE TABLE `orchestration_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`workspace_id` text,
	`kind` text NOT NULL,
	`target_id` text,
	`label` text NOT NULL,
	`status` text NOT NULL,
	`summary` text,
	`detail` text DEFAULT '{}' NOT NULL,
	`source` text DEFAULT 'api' NOT NULL,
	`external_run_id` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `orchestration_runs_user_idx` ON `orchestration_runs` (`user_id`,`started_at`);
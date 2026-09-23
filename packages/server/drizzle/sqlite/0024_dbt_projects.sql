CREATE TABLE `dbt_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`files` text NOT NULL,
	`vars` text DEFAULT '{}' NOT NULL,
	`target_schema` text DEFAULT 'main' NOT NULL,
	`schedule` text DEFAULT '{"kind":"manual"}' NOT NULL,
	`scheduled` text DEFAULT '{"command":"build"}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`next_run_at` integer,
	`last_run` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `dbt_projects_workspace_idx` ON `dbt_projects` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `dbt_projects_next_run_idx` ON `dbt_projects` (`next_run_at`);--> statement-breakpoint
CREATE TABLE `dbt_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text,
	`command` text NOT NULL,
	`select` text,
	`exclude` text,
	`full_refresh` integer DEFAULT false NOT NULL,
	`triggered_by` text NOT NULL,
	`status` text NOT NULL,
	`summary` text,
	`error` text,
	`log` text,
	`results` text DEFAULT '[]' NOT NULL,
	`duration_ms` integer,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `dbt_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `dbt_runs_project_idx` ON `dbt_runs` (`project_id`,`started_at`);
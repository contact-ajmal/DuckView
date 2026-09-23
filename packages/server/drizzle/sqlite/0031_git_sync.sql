CREATE TABLE `git_syncs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`repo_url` text NOT NULL,
	`branch` text DEFAULT 'main' NOT NULL,
	`path` text DEFAULT '' NOT NULL,
	`encrypted_secret` text,
	`iv` text,
	`tag` text,
	`created_by` text,
	`last_push_sha` text,
	`last_push_at` integer,
	`last_pull_sha` text,
	`last_pull_at` integer,
	`mapping` text DEFAULT '{}' NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `git_syncs_workspace_idx` ON `git_syncs` (`workspace_id`);
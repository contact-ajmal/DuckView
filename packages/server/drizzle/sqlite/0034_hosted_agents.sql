CREATE TABLE `hosted_agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`status` text NOT NULL,
	`triggered_by` text NOT NULL,
	`actor_id` text,
	`input` text NOT NULL,
	`output` text,
	`steps` text DEFAULT '[]' NOT NULL,
	`error` text,
	`model` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`notified` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`agent_id`) REFERENCES `hosted_agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `hosted_agent_runs_agent_idx` ON `hosted_agent_runs` (`agent_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `hosted_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`template` text,
	`instructions` text NOT NULL,
	`task` text NOT NULL,
	`tools` text DEFAULT '[]' NOT NULL,
	`max_steps` integer DEFAULT 8 NOT NULL,
	`schedule` text DEFAULT '{"kind":"manual"}' NOT NULL,
	`channel_ids` text DEFAULT '[]' NOT NULL,
	`published` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_run` text,
	`next_run_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `hosted_agents_workspace_idx` ON `hosted_agents` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `hosted_agents_next_run_idx` ON `hosted_agents` (`next_run_at`);
CREATE TABLE `agent_memories` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`scope` text DEFAULT 'user' NOT NULL,
	`kind` text NOT NULL,
	`subject` text,
	`text` text NOT NULL,
	`source_task_id` text,
	`uses` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_memories_ws_idx` ON `agent_memories` (`workspace_id`,`scope`);--> statement-breakpoint
CREATE TABLE `agent_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`session_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`subject` text,
	`text` text NOT NULL,
	`data` text,
	`tool` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `agent_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_observations_session_idx` ON `agent_observations` (`session_id`);--> statement-breakpoint
CREATE INDEX `agent_observations_ws_idx` ON `agent_observations` (`workspace_id`,`subject`);--> statement-breakpoint
CREATE TABLE `agent_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`via` text DEFAULT 'ui' NOT NULL,
	`page` text,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_sessions_user_idx` ON `agent_sessions` (`user_id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `agent_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`request` text NOT NULL,
	`mode` text DEFAULT 'auto' NOT NULL,
	`intent` text,
	`status` text NOT NULL,
	`plan` text DEFAULT '[]' NOT NULL,
	`steps` text DEFAULT '[]' NOT NULL,
	`artifacts` text DEFAULT '[]' NOT NULL,
	`actions` text DEFAULT '[]' NOT NULL,
	`approval` text,
	`answer` text,
	`error` text,
	`provider` text,
	`model` text,
	`telemetry` text,
	`trace_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_tasks_session_idx` ON `agent_tasks` (`session_id`);--> statement-breakpoint
CREATE INDEX `agent_tasks_user_idx` ON `agent_tasks` (`user_id`,`status`);--> statement-breakpoint
ALTER TABLE `revisions` ADD `actor_type` text;
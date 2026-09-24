CREATE TABLE `template_installs` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL,
	`template_name` text NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`table_map` text DEFAULT '{}' NOT NULL,
	`objects` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `template_installs_ws_idx` ON `template_installs` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`category` text DEFAULT 'Other' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`author_id` text NOT NULL,
	`status` text NOT NULL,
	`body` text NOT NULL,
	`installs` integer DEFAULT 0 NOT NULL,
	`reviewed_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `templates_status_idx` ON `templates` (`status`);--> statement-breakpoint
CREATE INDEX `templates_author_idx` ON `templates` (`author_id`);--> statement-breakpoint
CREATE TABLE `usage_budgets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`workspace_id` text,
	`amount_cents` integer NOT NULL,
	`thresholds` text DEFAULT '[80,100]' NOT NULL,
	`forecast` integer DEFAULT false NOT NULL,
	`channel_ids` text DEFAULT '[]' NOT NULL,
	`notified` text DEFAULT '' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `usage_budgets_workspace_idx` ON `usage_budgets` (`workspace_id`);
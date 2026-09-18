CREATE TABLE `group_members` (
	`group_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'MEMBER' NOT NULL,
	`added_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `group_members_pk` ON `group_members` (`group_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `group_members_user_idx` ON `group_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`external_id` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `groups_name_idx` ON `groups` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `groups_external_idx` ON `groups` (`external_id`);--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`role` text DEFAULT 'VIEWER' NOT NULL,
	`added_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`added_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_members_subject_idx` ON `workspace_members` (`workspace_id`,`subject_type`,`subject_id`);--> statement-breakpoint
CREATE INDEX `workspace_members_lookup_idx` ON `workspace_members` (`subject_type`,`subject_id`);--> statement-breakpoint
ALTER TABLE `session_tabs` ADD `user_id` text REFERENCES users(id) ON DELETE cascade;--> statement-breakpoint
CREATE INDEX `session_tabs_user_idx` ON `session_tabs` (`workspace_id`,`user_id`);--> statement-breakpoint
-- Tabs created before workspace sharing belong to the workspace owner.
UPDATE `session_tabs` SET `user_id` = (SELECT `user_id` FROM `workspaces` WHERE `workspaces`.`id` = `session_tabs`.`workspace_id`) WHERE `user_id` IS NULL;

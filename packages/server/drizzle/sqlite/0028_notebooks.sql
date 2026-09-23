CREATE TABLE `notebooks` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`cells` text DEFAULT '[]' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notebooks_workspace_idx` ON `notebooks` (`workspace_id`);
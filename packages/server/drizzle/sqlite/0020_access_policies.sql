CREATE TABLE `access_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`table_name` text NOT NULL,
	`row_filter` text,
	`column_masks` text DEFAULT '{}' NOT NULL,
	`applies_to` text DEFAULT '{"roles":["VIEWER"]}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `access_policies_workspace_idx` ON `access_policies` (`workspace_id`);
CREATE TABLE `catalog_annotations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`object_name` text NOT NULL,
	`column_name` text,
	`description` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `catalog_annotations_workspace_idx` ON `catalog_annotations` (`workspace_id`,`object_name`);
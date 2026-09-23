CREATE TABLE `revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`object_type` text NOT NULL,
	`object_id` text NOT NULL,
	`number` integer NOT NULL,
	`snapshot` text NOT NULL,
	`message` text,
	`named` integer DEFAULT false NOT NULL,
	`user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `revisions_object_idx` ON `revisions` (`object_type`,`object_id`,`number`);
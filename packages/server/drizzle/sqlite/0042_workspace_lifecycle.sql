CREATE TABLE `workspace_backups` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`kind` text NOT NULL,
	`file` text NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`tables` integer DEFAULT 0 NOT NULL,
	`objects` text DEFAULT '{"queries":0,"dashboards":0,"notebooks":0,"quality":0}' NOT NULL,
	`note` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workspace_backups_ws_idx` ON `workspace_backups` (`workspace_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `workspaces` ADD `backup_policy` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `last_backup_at` integer;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `idle_warned_at` integer;
ALTER TABLE `workspaces` ADD `description` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `tags` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `color` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `archived_at` integer;
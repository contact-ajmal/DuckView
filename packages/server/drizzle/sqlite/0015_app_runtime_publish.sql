ALTER TABLE `data_apps` ADD `always_on` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `data_apps` ADD `runtime` text;--> statement-breakpoint
ALTER TABLE `data_apps` ADD `publish_status` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `data_apps` ADD `publish_requested_by` text;--> statement-breakpoint
ALTER TABLE `data_apps` ADD `publish_requested_at` integer;--> statement-breakpoint
ALTER TABLE `data_apps` ADD `publish_reviewed_by` text;--> statement-breakpoint
ALTER TABLE `data_apps` ADD `publish_reviewed_at` integer;--> statement-breakpoint
ALTER TABLE `data_apps` ADD `publish_note` text;--> statement-breakpoint
UPDATE `data_apps` SET `publish_status` = 'approved' WHERE `visibility` = 'org';
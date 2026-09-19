ALTER TABLE `dashboards` ADD `kind` text DEFAULT 'grid' NOT NULL;--> statement-breakpoint
ALTER TABLE `dashboards` ADD `spec` text;
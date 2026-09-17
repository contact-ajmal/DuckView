CREATE TABLE `lakehouse_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`alias` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`encrypted_credentials` text NOT NULL,
	`iv` text NOT NULL,
	`tag` text NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`last_error` text,
	`last_tested_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `lakehouse_connections_user_idx` ON `lakehouse_connections` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `lakehouse_connections_alias_idx` ON `lakehouse_connections` (`user_id`,`alias`);--> statement-breakpoint
ALTER TABLE `session_tabs` ADD `engine` text;
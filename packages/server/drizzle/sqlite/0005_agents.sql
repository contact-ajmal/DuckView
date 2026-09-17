CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`framework` text NOT NULL,
	`description` text,
	`workspace_id` text,
	`token_id` text,
	`allow_mutations` integer DEFAULT false NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`call_count` integer DEFAULT 0 NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL,
	`last_seen_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`token_id`) REFERENCES `api_tokens`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `agents_user_idx` ON `agents` (`user_id`);--> statement-breakpoint
CREATE INDEX `agents_token_idx` ON `agents` (`token_id`);
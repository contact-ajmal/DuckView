CREATE TABLE `a2a_remotes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`card_url` text NOT NULL,
	`endpoint` text NOT NULL,
	`card` text NOT NULL,
	`encrypted_headers` text,
	`iv` text,
	`tag` text,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `a2a_remotes_user_idx` ON `a2a_remotes` (`user_id`);--> statement-breakpoint
ALTER TABLE `hosted_agent_runs` ADD `context_id` text;
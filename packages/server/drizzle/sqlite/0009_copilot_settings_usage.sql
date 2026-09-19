CREATE TABLE `copilot_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`model` text,
	`base_url` text,
	`encrypted_api_key` text,
	`iv` text,
	`tag` text,
	`key_hint` text,
	`aws_region` text,
	`bedrock_agent_id` text,
	`bedrock_agent_alias_id` text,
	`agentcore_runtime_arn` text,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `copilot_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`message_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`action` text NOT NULL,
	`byok` integer DEFAULT false NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`duration_ms` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `copilot_usage_user_idx` ON `copilot_usage` (`user_id`);--> statement-breakpoint
CREATE INDEX `copilot_usage_created_idx` ON `copilot_usage` (`created_at`);--> statement-breakpoint
CREATE INDEX `copilot_usage_conversation_idx` ON `copilot_usage` (`conversation_id`);
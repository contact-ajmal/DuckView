CREATE TABLE `data_apps` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`kind` text DEFAULT 'streamlit' NOT NULL,
	`entry` text DEFAULT 'app.py' NOT NULL,
	`files` text DEFAULT '{}' NOT NULL,
	`spec` text,
	`visibility` text DEFAULT 'workspace' NOT NULL,
	`status` text DEFAULT 'stopped' NOT NULL,
	`port` integer,
	`pid` integer,
	`last_error` text,
	`last_started_at` integer,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `data_apps_workspace_idx` ON `data_apps` (`workspace_id`);